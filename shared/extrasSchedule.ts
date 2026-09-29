/**
 * Escala automática do Extras-dia — regras PURAS (sem BD nem rede), partilhadas
 * entre o servidor (server/extrasSchedule.ts) e os testes.
 *
 *  - capacidade por cidade: condutores precisos numa hora = ⌈carros ÷ carros/hora⌉;
 *  - janela de disponibilidade de um extra no dia operacional (03h → 03h);
 *  - ordenação dos candidatos (cobertura, avaliação, custo, equidade,
 *    fiabilidade) com a explicação ("porquê") de cada escolha;
 *  - preenchimento guloso das horas em falta respeitando 3h ≤ turno ≤ 12h;
 *  - buracos ("faltam 2 condutores entre 14h–17h");
 *  - horários do cron (hora de Lisboa) e deduplicação dos avisos.
 *
 * Determinístico: os mesmos dados dão sempre a mesma proposta.
 */

// ─── Limites ────────────────────────────────────────────────────────────────

export const MIN_SHIFT_HOURS = 3;
export const MAX_SHIFT_HOURS = 12;
/** Dia operacional: 03h do dia → 03h do dia seguinte (hora 27). */
export const DAY_START_HOUR = 3;
export const DAY_END_HOUR = 27;
/** Capacidade usada se a definição não existir/for inválida. */
export const FALLBACK_CARS_PER_HOUR = 3;

// ─── Capacidade ─────────────────────────────────────────────────────────────

/** Carros/hora por condutor de uma cidade, com fallback. */
export function carsPerHourFor(map: Partial<Record<string, number>> | null | undefined, city: string): number {
  const v = map?.[city];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : FALLBACK_CARS_PER_HOUR;
}

/** Condutores precisos para `cars` carros numa hora. */
export function driversNeededFor(cars: number, carsPerHour: number): number {
  if (!(cars > 0)) return 0;
  const cph = carsPerHour > 0 ? carsPerHour : FALLBACK_CARS_PER_HOUR;
  // −1e-9: 4,5 carros ÷ 1,5 não pode dar 4 por erro de vírgula flutuante.
  return Math.ceil(cars / cph - 1e-9);
}

// ─── Horas e textos ─────────────────────────────────────────────────────────

const WEEKDAYS_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** 6 → "06h"; 27 → "03h" (madrugada seguinte). */
export function hh(h: number): string {
  return `${String(((h % 24) + 24) % 24).padStart(2, "0")}h`;
}

/** "sexta 26/09" */
export function fmtDayPt(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAYS_PT[d.getUTCDay()]} ${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

export const CITY_LABELS_PT: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };

/** Texto do aviso (1 linha — vai no {{2}} do template WhatsApp e no email). */
export function scheduleMessageText(opts: {
  date: string;
  spans: { startHour: number; endHour: number }[];
  city: string;
  meetingPoint?: string | null;
}): string {
  const spans = opts.spans.slice().sort((a, b) => a.startHour - b.startHour);
  const hours = spans.map((s) => `das ${hh(s.startHour)} às ${hh(s.endHour)}`).join(" e ");
  const parts = [`${fmtDayPt(opts.date)}, ${hours}`, CITY_LABELS_PT[opts.city] ?? opts.city];
  const mp = (opts.meetingPoint ?? "").trim();
  if (mp) parts.push(`ponto de encontro: ${mp}`);
  return parts.join(" · ").replace(/\s+/g, " ").slice(0, 400);
}

// ─── Disponibilidade → janela ──────────────────────────────────────────────

export interface AvailabilityLike {
  status: string;
  morning: boolean;
  night: boolean;
  fromHour: number | null;
  toHour: number | null;
}

/**
 * Janela [from, to) em horas do dia operacional (3–27) em que o extra disse
 * que pode; null = não está disponível. Horas soltas (0–23) antes das 03h
 * são da madrugada seguinte; um fim ≤ início atravessa a meia-noite.
 */
export function availabilityWindow(a: AvailabilityLike | null | undefined): { from: number; to: number } | null {
  if (!a || a.status !== "available") return null;
  let from: number;
  let to: number;
  if (a.fromHour != null || a.toHour != null) {
    from = a.fromHour != null ? (a.fromHour < DAY_START_HOUR ? a.fromHour + 24 : a.fromHour) : DAY_START_HOUR;
    to = a.toHour != null ? a.toHour : DAY_END_HOUR;
    if (a.toHour != null && to <= from) to += 24;
  } else if (a.morning && a.night) {
    from = DAY_START_HOUR; to = DAY_END_HOUR;
  } else if (a.morning) {
    from = DAY_START_HOUR; to = 15;
  } else if (a.night) {
    from = 15; to = DAY_END_HOUR;
  } else {
    return null;
  }
  from = Math.max(DAY_START_HOUR, from);
  to = Math.min(DAY_END_HOUR, to);
  return to > from ? { from, to } : null;
}

// ─── Candidatos e ordenação ─────────────────────────────────────────────────

export type LevelId = "junior" | "senior" | "terminal" | "master";

export interface ScheduleCandidate {
  id: number;
  fullName: string;
  level: LevelId;
  levelLabel: string;
  hourlyRate: number;
  /** Janela em que pode (availabilityWindow); null = não entra. */
  window: { from: number; to: number } | null;
  /** Pontos médios por dia trabalhado (avaliação, últimas 4 semanas); null = sem dados. */
  evalScore: number | null;
  /** Dias escalados nos últimos 14 dias (equidade). */
  recentDays: number;
  /** Faltas confirmadas nos últimos 60 dias. */
  noShows: number;
  /** "Não posso" a avisos de escala nos últimos 60 dias. */
  declines: number;
}

export const RANK_WEIGHTS = { coverage: 0.45, eval: 0.2, cost: 0.15, fairness: 0.12, reliability: 0.08 } as const;

export interface RankFactors {
  coverage: number;
  eval: number;
  cost: number;
  fairness: number;
  reliability: number;
  total: number;
}

export interface Block {
  startHour: number;
  endHour: number;
  /** Horas do bloco com falta de gente. */
  coveredHours: number;
}

/**
 * Melhor bloco contínuo para um candidato: dentro da janela, a cobrir as horas
 * com falta (remaining > 0), com MIN ≤ duração ≤ MAX. null = não ajuda.
 */
export function bestBlock(
  window: { from: number; to: number },
  remaining: readonly number[],
  minH = MIN_SHIFT_HOURS,
  maxH = MAX_SHIFT_HOURS,
): Block | null {
  const from = Math.max(DAY_START_HOUR, window.from);
  const to = Math.min(DAY_END_HOUR, window.to, remaining.length);
  if (to - from < minH) return null;
  const demand = (h: number) => ((remaining[h] ?? 0) > 0 ? 1 : 0);
  // Todos os blocos [s, s+L) com MIN ≤ L ≤ MAX dentro da janela; valor =
  // horas em falta cobertas − IDLE_PENALTY × horas pagas sem falta. Assim um
  // pico às 08h e outro às 14h dão dois turnos curtos, não um de 7h com 4h
  // paradas (o passo de "alargar" do planSchedule junta-os se faltar gente).
  // Empates: mais horas cobertas, mais curto, a começar numa hora com falta,
  // mais cedo.
  let best: (Block & { value: number; onDemand: number }) | null = null;
  for (let s = from; s + minH <= to; s++) {
    let covered = 0;
    for (let h = s; h < s + minH - 1; h++) covered += demand(h);
    for (let L = minH; L <= maxH && s + L <= to; L++) {
      covered += demand(s + L - 1);
      if (covered === 0) continue;
      const value = covered - IDLE_PENALTY * (L - covered);
      if (
        !best ||
        value > best.value + 1e-9 ||
        (Math.abs(value - best.value) <= 1e-9 && (covered > best.coveredHours ||
          (covered === best.coveredHours && (L < best.endHour - best.startHour ||
            (L === best.endHour - best.startHour && (demand(s) > best.onDemand ||
              (demand(s) === best.onDemand && s < best.startHour)))))))
      ) {
        best = { startHour: s, endHour: s + L, coveredHours: covered, value, onDemand: demand(s) };
      }
    }
  }
  return best ? { startHour: best.startHour, endHour: best.endHour, coveredHours: best.coveredHours } : null;
}

/** Peso de cada hora paga sem falta de gente na escolha do bloco. */
export const IDLE_PENALTY = 0.5;

function norm(v: number, min: number, max: number): number {
  return max > min ? (v - min) / (max - min) : 1;
}

export interface RankedCandidate {
  candidate: ScheduleCandidate;
  block: Block;
  factors: RankFactors;
}

/**
 * Ordena os candidatos para as horas ainda em falta. Só entra quem tem janela e
 * um bloco que ajude. Critério: soma ponderada (RANK_WEIGHTS) de
 * cobertura > avaliação > custo > equidade > fiabilidade; empates por horas
 * cobertas, custo, nome e id (determinístico).
 */
export function rankCandidates(
  candidates: readonly ScheduleCandidate[],
  remaining: readonly number[],
  opts: { minShiftHours?: number; maxShiftHours?: number } = {},
): RankedCandidate[] {
  const minH = opts.minShiftHours ?? MIN_SHIFT_HOURS;
  const maxH = opts.maxShiftHours ?? MAX_SHIFT_HOURS;
  const demandHours = remaining.reduce((n, r, h) => n + (h >= DAY_START_HOUR && r > 0 ? 1 : 0), 0);
  const withBlock: { candidate: ScheduleCandidate; block: Block }[] = [];
  for (const c of candidates) {
    if (!c.window) continue;
    const block = bestBlock(c.window, remaining, minH, maxH);
    if (block) withBlock.push({ candidate: c, block });
  }
  if (!withBlock.length) return [];
  const evals = withBlock.map((x) => x.candidate.evalScore).filter((v): v is number => v != null);
  const evMin = evals.length ? Math.min(...evals) : 0;
  const evMax = evals.length ? Math.max(...evals) : 0;
  const rates = withBlock.map((x) => x.candidate.hourlyRate);
  const rMin = Math.min(...rates);
  const rMax = Math.max(...rates);

  const ranked = withBlock.map(({ candidate: c, block }) => {
    const coverage = demandHours > 0 ? block.coveredHours / demandHours : 0;
    const ev = c.evalScore == null ? 0.5 : norm(c.evalScore, evMin, evMax);
    const cost = rMax > rMin ? 1 - norm(c.hourlyRate, rMin, rMax) : 1;
    const fairness = 1 - Math.min(Math.max(0, c.recentDays), 7) / 7;
    const reliability = Math.max(0, 1 - 0.5 * Math.max(0, c.noShows) - 0.2 * Math.max(0, c.declines));
    const w = RANK_WEIGHTS;
    const total = w.coverage * coverage + w.eval * ev + w.cost * cost + w.fairness * fairness + w.reliability * reliability;
    const factors: RankFactors = {
      coverage: round3(coverage), eval: round3(ev), cost: round3(cost), fairness: round3(fairness), reliability: round3(reliability), total: round3(total),
    };
    return { candidate: c, block, factors };
  });
  ranked.sort((a, b) =>
    b.factors.total - a.factors.total ||
    b.block.coveredHours - a.block.coveredHours ||
    a.candidate.hourlyRate - b.candidate.hourlyRate ||
    a.candidate.fullName.localeCompare(b.candidate.fullName) ||
    a.candidate.id - b.candidate.id,
  );
  return ranked;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const fmtNum = (n: number, d = 1) => n.toFixed(d).replace(".", ",");

/** "Porquê" de uma escolha — texto curto a partir dos fatores. */
export function buildReason(r: RankedCandidate, ctx: { evalRank?: number | null; evalCount?: number } = {}): string {
  const c = r.candidate;
  const parts: string[] = [];
  const win = c.window;
  parts.push(
    `${win ? `disponível ${hh(win.from)}–${hh(win.to)}` : "disponível"}; cobre ${r.block.coveredHours}h com falta de gente (${hh(r.block.startHour)}–${hh(r.block.endHour)})`,
  );
  if (c.evalScore == null) parts.push("sem avaliação recente");
  else parts.push(`avaliação ${fmtNum(c.evalScore)} pts/dia${ctx.evalRank && ctx.evalCount ? ` (${ctx.evalRank}.º de ${ctx.evalCount})` : ""}`);
  parts.push(`${c.levelLabel} ${fmtNum(c.hourlyRate, 2)} €/h`);
  parts.push(c.recentDays > 0 ? `${c.recentDays} dia(s) escalado(s) nos últimos 14` : "não foi escalado nos últimos 14 dias");
  if (c.noShows || c.declines) {
    const bits: string[] = [];
    if (c.noShows) bits.push(`${c.noShows} falta(s)`);
    if (c.declines) bits.push(`${c.declines} recusa(s)`);
    parts.push(`${bits.join(" e ")} nos últimos 60 dias`);
  } else {
    parts.push("sem faltas recentes");
  }
  const text = parts.join(" · ");
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 500);
}

// ─── Proposta ───────────────────────────────────────────────────────────────

export interface Span { startHour: number; endHour: number; sentHomeHour?: number | null }

export interface ProposalPick {
  employeeId: number;
  personName: string;
  level: LevelId;
  hourlyRate: number;
  startHour: number;
  endHour: number;
  shift: "morning" | "night";
  reason: string;
  factors: RankFactors;
}

export interface Gap { fromHour: number; toHour: number; missing: number }

export interface PlanResult {
  picks: ProposalPick[];
  /** Falta de gente por hora DEPOIS da proposta. */
  remaining: number[];
  gaps: Gap[];
}

/** Falta por hora: pedido − escalados (mandado para casa conta até à hora). */
export function remainingNeed(needed: readonly number[], existing: readonly Span[]): number[] {
  return needed.map((n, h) => {
    const have = existing.filter((a) => a.startHour <= h && h < (a.sentHomeHour ?? a.endHour)).length;
    return Math.max(0, (n ?? 0) - have);
  });
}

/**
 * Proposta gulosa: enquanto houver horas em falta, escolhe o melhor candidato
 * (reordenado a cada passo, porque a cobertura muda) e dá-lhe o seu melhor
 * bloco. Cada pessoa entra no máximo uma vez; quem está em `exclude` não entra.
 */
export function planSchedule(input: {
  needed: readonly number[];
  existing: readonly Span[];
  candidates: readonly ScheduleCandidate[];
  exclude?: ReadonlySet<number>;
  minShiftHours?: number;
  maxShiftHours?: number;
}): PlanResult {
  const remaining = remainingNeed(input.needed, input.existing);
  for (let h = 0; h < Math.min(DAY_START_HOUR, remaining.length); h++) remaining[h] = 0;
  const pool = input.candidates.filter((c) => !input.exclude?.has(c.id));
  const evalSorted = pool.map((c) => c.evalScore).filter((v): v is number => v != null).sort((a, b) => b - a);
  const picks: ProposalPick[] = [];
  const used = new Set<number>();
  for (let guard = 0; guard < 500; guard++) {
    if (!remaining.some((r) => r > 0)) break;
    const ranked = rankCandidates(pool.filter((c) => !used.has(c.id)), remaining, input);
    const best = ranked[0];
    if (!best) break;
    const c = best.candidate;
    used.add(c.id);
    for (let h = best.block.startHour; h < best.block.endHour; h++) remaining[h] = Math.max(0, remaining[h] - 1);
    const evalRank = c.evalScore != null ? evalSorted.indexOf(c.evalScore) + 1 : null;
    picks.push({
      employeeId: c.id,
      personName: c.fullName,
      level: c.level,
      hourlyRate: c.hourlyRate,
      startHour: best.block.startHour,
      endHour: best.block.endHour,
      shift: best.block.startHour < 15 ? "morning" : "night",
      reason: buildReason(best, { evalRank, evalCount: evalSorted.length }),
      factors: best.factors,
    });
  }
  extendPicksIntoGaps(picks, remaining, pool, input.maxShiftHours ?? MAX_SHIFT_HOURS);
  return { picks, remaining, gaps: summarizeGaps(remaining) };
}

/**
 * Passo 2: se ainda há horas em falta e já não há ninguém livre, alarga o
 * turno de quem já foi proposto (dentro da janela dele e do máximo de horas),
 * escolhendo o alargamento com menos horas a mais. Muda `picks` e `remaining`.
 */
export function extendPicksIntoGaps(
  picks: ProposalPick[],
  remaining: number[],
  candidates: readonly ScheduleCandidate[],
  maxH = MAX_SHIFT_HOURS,
): void {
  const windowOf = new Map(candidates.map((c) => [c.id, c.window]));
  const unfixable = new Set<number>();
  for (let guard = 0; guard < 500; guard++) {
    const h = remaining.findIndex((r, i) => i >= DAY_START_HOUR && r > 0 && !unfixable.has(i));
    if (h < 0) break;
    let best: { p: ProposalPick; start: number; end: number; added: number } | null = null;
    for (const p of picks) {
      const w = windowOf.get(p.employeeId);
      if (!w || h < w.from || h >= w.to) continue;
      if (h >= p.startHour && h < p.endHour) continue;
      const start = Math.min(p.startHour, h);
      const end = Math.max(p.endHour, h + 1);
      if (end - start > maxH) continue;
      const added = end - start - (p.endHour - p.startHour);
      if (!best || added < best.added) best = { p, start, end, added };
    }
    if (!best) { unfixable.add(h); continue; }
    const { p, start, end } = best;
    for (let x = start; x < end; x++) {
      if (x < p.startHour || x >= p.endHour) remaining[x] = Math.max(0, remaining[x] - 1);
    }
    p.reason = `${p.reason} · turno alargado para ${hh(start)}–${hh(end)} por falta de gente`.slice(0, 500);
    p.startHour = start;
    p.endHour = end;
    p.shift = start < 15 ? "morning" : "night";
  }
}

/** Horas seguidas com falta → um buraco (falta = o máximo nessas horas). */
export function summarizeGaps(remaining: readonly number[]): Gap[] {
  const gaps: Gap[] = [];
  let cur: Gap | null = null;
  for (let h = 0; h < remaining.length; h++) {
    const r = remaining[h] ?? 0;
    if (r > 0) {
      if (cur && cur.toHour === h) { cur.toHour = h + 1; cur.missing = Math.max(cur.missing, r); }
      else { cur = { fromHour: h, toHour: h + 1, missing: r }; gaps.push(cur); }
    } else {
      cur = null;
    }
  }
  return gaps;
}

/** "faltam 2 condutores entre 14h–17h" */
export function describeGap(g: Gap): string {
  return `${g.missing === 1 ? "falta 1 condutor" : `faltam ${g.missing} condutores`} entre ${hh(g.fromHour)}–${hh(g.toHour)}`;
}

export interface ProposalSummary {
  date: string;
  city: string;
  carsPerHour: number;
  peakDrivers: number;
  peakHour: number | null;
  picks: { personName: string; startHour: number; endHour: number; hourlyRate: number }[];
  keptCount: number;
  gaps: Gap[];
}

/**
 * Resumo da proposta em texto.
 *
 * TODO(ai): trocar por um resumo escrito pela camada de IA (server/_core/ai/)
 * quando estiver disponível — manter esta versão determinística como fallback.
 */
export function explainProposal(p: ProposalSummary): string {
  const hours = p.picks.reduce((s, x) => s + (x.endHour - x.startHour), 0);
  const cost = p.picks.reduce((s, x) => s + (x.endHour - x.startHour) * x.hourlyRate, 0);
  const city = CITY_LABELS_PT[p.city] ?? p.city;
  const parts: string[] = [];
  parts.push(`Proposta para ${fmtDayPt(p.date)} em ${city}: ${p.picks.length} condutor(es) propostos (${hours}h, ${fmtNum(cost, 2)} €)${p.keptCount ? ` além de ${p.keptCount} já escalado(s)` : ""}.`);
  parts.push(`Capacidade ${fmtNum(p.carsPerHour, p.carsPerHour % 1 ? 1 : 0)} carros/hora por condutor; pico de ${p.peakDrivers} condutor(es)${p.peakHour != null ? ` às ${hh(p.peakHour)}` : ""}.`);
  if (p.gaps.length) parts.push(`Atenção: ${p.gaps.map(describeGap).join("; ")}.`);
  else if (p.peakDrivers > 0) parts.push("Todas as horas previstas ficam cobertas.");
  else parts.push("Sem operações previstas — não são precisos condutores.");
  return parts.join(" ");
}

// ─── Relógio de Lisboa e horários do cron ───────────────────────────────────

export interface LisbonNow { date: string; minutes: number }

export function lisbonNow(now: Date = new Date()): LisbonNow {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now)) p[x.type] = x.value;
  const hour = Number(p.hour === "24" ? "0" : p.hour);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + Number(p.minute) };
}

export function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface ScheduleSettings {
  autoProposeAtMin: number;
  daysAhead: number;
  autoConfirm: boolean;
  autoConfirmAtMin: number;
}

/**
 * O que o cron deve fazer agora (hora de Lisboa):
 *  - a partir de autoProposeAt → propor amanhã … +daysAhead (quem já tem
 *    proposta/escala fica como está — idempotente no servidor);
 *  - a partir de autoConfirmAt (se autoConfirm) → confirmar a de amanhã.
 */
export function scheduleDue(now: LisbonNow, s: ScheduleSettings): { proposeDates: string[]; confirmDates: string[] } {
  const proposeDates: string[] = [];
  if (now.minutes >= s.autoProposeAtMin) {
    for (let i = 1; i <= Math.max(1, Math.min(7, s.daysAhead)); i++) proposeDates.push(addDaysIso(now.date, i));
  }
  const confirmDates = s.autoConfirm && now.minutes >= s.autoConfirmAtMin ? [addDaysIso(now.date, 1)] : [];
  return { proposeDates, confirmDates };
}

/** Pode confirmar automaticamente? Só propostas por confirmar e sem "suspender". */
export function canAutoConfirm(state: { status: string; holdAuto: boolean } | null): boolean {
  return !!state && state.status === "proposed" && !state.holdAuto;
}

// ─── Deduplicação dos avisos ────────────────────────────────────────────────

export type NotifyChannel = "whatsapp" | "email";
export type NotifyKind = "scheduled" | "removed";

/** Estados finais (não se volta a tentar a mesma versão). */
export const FINAL_NOTIFY_STATUSES = new Set(["sent", "opted_out", "invalid", "no_contact", "skipped"]);
export const MAX_NOTIFY_ATTEMPTS = 3;

export interface NotifyLogRow {
  assignmentId: number;
  version: number;
  kind: NotifyKind;
  channel: NotifyChannel;
  status: string;
  attempts: number;
}

/** Já tratado para esta versão/canal? (falhado conta até MAX_NOTIFY_ATTEMPTS tentativas) */
export function notificationDone(
  a: { id: number; version: number },
  log: readonly NotifyLogRow[],
  kind: NotifyKind,
  channel: NotifyChannel,
  legacyWhatsappSent: ReadonlySet<number> = new Set(),
): boolean {
  if (kind === "scheduled" && channel === "whatsapp" && a.version === 1 && legacyWhatsappSent.has(a.id)) return true;
  const row = log.find((r) => r.assignmentId === a.id && r.version === a.version && r.kind === kind && r.channel === channel);
  if (!row) return false;
  if (FINAL_NOTIFY_STATUSES.has(row.status)) return true;
  // 'sending' fica para a reserva no servidor decidir (em curso vs. esquecida).
  return row.status === "failed" && row.attempts >= MAX_NOTIFY_ATTEMPTS;
}

/** Linhas da escala que precisam de aviso "escalado" neste canal. */
export function pendingScheduleNotifications<T extends { id: number; version: number; status: string; employeeId: number | null }>(
  rows: readonly T[],
  log: readonly NotifyLogRow[],
  channel: NotifyChannel,
  legacyWhatsappSent: ReadonlySet<number> = new Set(),
): T[] {
  return rows.filter((a) => a.status === "confirmed" && a.employeeId != null && !notificationDone(a, log, "scheduled", channel, legacyWhatsappSent));
}

/** Quem sai de uma escala confirmada e já tinha sido avisado recebe aviso de remoção. */
export function shouldNotifyRemoval(row: { status: string; employeeId: number | null }, wasNotified: boolean): boolean {
  return row.status === "confirmed" && row.employeeId != null && wasNotified;
}

/** Estado do aviso a partir do resultado do envio WhatsApp (sendBroadcast). */
export function whatsappOutcomeStatus(recipientStatus: string | null | undefined): "sent" | "opted_out" | "invalid" | "failed" | "no_contact" {
  switch (recipientStatus) {
    case "sent": return "sent";
    case "opted_out": return "opted_out";
    case "invalid_phone": return "invalid";
    case "duplicate_phone": return "invalid";
    case null:
    case undefined: return "no_contact";
    default: return "failed";
  }
}

/** Resultado honesto do cron: vermelho só com erros (avisos não contam). */
export function scheduleCronOk(report: { errors: readonly string[] }): boolean {
  return report.errors.length === 0;
}
