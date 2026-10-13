/**
 * TERMINAL PELO PERFIL — o que se vê e decide DEPOIS (plano 56, entrega B2):
 *  - RH → ficha → Ponto: os troços de terminal de cada turno; o RH confirma,
 *    corrige (de–a) ou desmarca, sempre com motivo. Não deixa sobrepor dois
 *    troços na mesma cidade (nem dois da mesma pessoa). Nada se apaga: o
 *    resultado automático fica guardado (`autoCountedUntil/Basis`) e o antes →
 *    depois vai para os Logs.
 *  - Meses fechados (fecho do ordenado aprovado ou pago) não mudam: o RH e a
 *    repetição automática não mexem em sessões desses meses.
 *  - Atividade diária → Resumo do dia: linha do tempo do terminal por cidade
 *    (quem, de–a, como fechou, até que hora contou) com os buracos
 *    "terminal vazio 12:10–12:40".
 *  - Repetição automática (daily-ops, a seguir ao fecho dos pontos
 *    esquecidos): as sessões dos últimos 7 dias "por confirmar" ou só com o
 *    último GPS voltam a ler a Multipark (só leitura) — uma leitura para todas.
 * Regras puras em shared/terminalWatch.ts.
 */
import { lisbonClock, TERMINAL_RETRY_DAYS, resolveTerminalByLastService } from "../shared/pontoTerminal";
import {
  TERMINAL_CITY_LABELS, TERMINAL_CITY_OF, TERMINAL_END_REASON_LABELS, TERMINAL_REASON_MIN, TERMINAL_START_SOURCE_LABELS, toDbUtc, toMs,
  type TerminalCityKey, type TerminalCountedBasis, type TerminalEndReason,
} from "../shared/terminalSession";
import {
  TERMINAL_BASIS_LABELS, claimUnproven, cityDayTimeline, countedLabel, improvesCounted, isPaidBasis, outsideConfirmed, overlapConflict, serviceCap,
} from "../shared/terminalWatch";
import { operationalDayWindowUtc } from "../shared/shiftHandover";
import { OFF_MESSAGE, TerminalError, nameOf, safeLog, type TerminalDeps, type TerminalSessionRow } from "./terminalSessions";
import { monthLabel, touchesClosedMonth } from "./terminalPay";
import type { TerminalServiceReader } from "./pontoTerminal";

// ─── RH → ficha → Ponto ─────────────────────────────────────────────────────

export interface RhTerminalSession {
  id: number;
  employeeId: number;
  cityKey: TerminalCityKey;
  cityLabel: string;
  startedAt: string;
  endedAt: string | null;
  open: boolean;
  startSource: string;
  sourceLabel: string;
  endReason: string | null;
  endReasonLabel: string | null;
  endNote: string | null;
  note: string | null;
  countedFrom: string | null;
  countedUntil: string | null;
  countedBasis: TerminalCountedBasis | null;
  countedLabel: string;
  paid: boolean;
  /** nível +1 (só extras) */
  payUplift: boolean;
  /** por confirmar: sem prova (pending), ou "Ainda estou" sem prova no fim */
  needsReview: boolean;
  claimUnproven: boolean;
  lastInsideAt: string | null;
  leftAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  autoCountedUntil: string | null;
  autoCountedBasis: string | null;
  /** mês fechado (fecho do ordenado aprovado/pago) → o RH já não mexe */
  closedMonth: string | null;
}

/**
 * Os meses com o ordenado fechado. Erro a ler → TerminalError (o RH não mexe:
 * um erro nunca vale por "nenhum mês fechado").
 */
async function closedMonthsOrRefuse(deps: TerminalDeps): Promise<Set<string>> {
  if (!deps.closedMonths) return new Set<string>();
  try {
    return await deps.closedMonths();
  } catch (err) {
    console.warn("[terminal] fechos do ordenado não lidos:", String((err as Error)?.message ?? err).slice(0, 160));
    throw new TerminalError("Não deu para ver se o ordenado deste mês já está fechado. Tenta outra vez daqui a pouco.");
  }
}

/** O mês fechado que a sessão toca (pela entrada do ponto dela), ou null. */
async function closedMonthOf(deps: TerminalDeps, closed: ReadonlySet<string>, s: TerminalSessionRow, extra: Array<string | null | undefined> = []): Promise<string | null> {
  if (!closed.size) return null;
  const instants = [s.startedAt, s.endedAt, ...extra];
  // por cautela primeiro (16 h para trás); só se tocar um mês fechado se lê a entrada do ponto para decidir ao certo
  if (!touchesClosedMonth(closed, { instants })) return null;
  const shiftStartAt = s.timeRecordId && deps.clockInAt ? await deps.clockInAt(s.timeRecordId).catch(() => null) : null;
  return touchesClosedMonth(closed, { shiftStartAt, instants });
}

function rhView(s: TerminalSessionRow, cm: string | null): RhTerminalSession {
  const basis = (s.countedBasis ?? null) as TerminalCountedBasis | null;
  const claim = claimUnproven(s);
  const out = { outsideSinceMs: s.outsideSince ? toMs(s.outsideSince) : null, outsideCount: Number(s.outsideCount ?? 0) };
  return {
    id: s.id, employeeId: s.employeeId, cityKey: s.cityKey, cityLabel: TERMINAL_CITY_LABELS[s.cityKey] ?? s.cityKey,
    startedAt: s.startedAt, endedAt: s.endedAt, open: !s.endedAt,
    startSource: s.startSource, sourceLabel: TERMINAL_START_SOURCE_LABELS[s.startSource] ?? s.startSource,
    endReason: s.endReason, endReasonLabel: s.endReason ? TERMINAL_END_REASON_LABELS[s.endReason as TerminalEndReason] ?? s.endReason : null,
    endNote: s.endNote ?? null, note: s.note ?? null,
    countedFrom: s.countedFrom ?? null, countedUntil: s.countedUntil ?? null, countedBasis: basis,
    countedLabel: countedLabel(s), paid: isPaidBasis(basis), payUplift: Number(s.payUplift) === 1,
    needsReview: !!s.endedAt && (basis === "pending" || basis == null || claim),
    claimUnproven: claim,
    lastInsideAt: s.lastInsideAt ?? null,
    leftAt: outsideConfirmed(out) ? s.outsideSince ?? null : null,
    reviewedAt: s.reviewedAt ?? null, reviewNote: s.reviewNote ?? null,
    autoCountedUntil: s.autoCountedUntil ?? null, autoCountedBasis: s.autoCountedBasis ?? null,
    closedMonth: cm ? monthLabel(cm) : null,
  };
}

/** Os troços de terminal de uma ficha num intervalo (UTC). Desligado → `enabled: false` e nada. */
export async function rhSessionsOf(deps: TerminalDeps, o: { employeeId: number; fromUtc: string; toUtc: string }): Promise<{ enabled: boolean; sessions: RhTerminalSession[] }> {
  if (!(await deps.enabled())) return { enabled: false, sessions: [] };
  const [rows, closed] = await Promise.all([
    deps.store.sessionsBetween({ employeeId: o.employeeId, fromUtc: o.fromUtc, toUtc: o.toUtc }),
    // (só para mostrar: se falhar, a lista abre na mesma — quem decide é o servidor, que recusa)
    deps.closedMonths ? deps.closedMonths().catch(() => new Set<string>()) : Promise.resolve(new Set<string>()),
  ]);
  const views: RhTerminalSession[] = [];
  for (const r of rows) views.push(rhView(r, await closedMonthOf(deps, closed, r)));
  return { enabled: true, sessions: views.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)) };
}

export interface RhActor { userId: number }

const noteOf = (n: string): string => {
  const t = String(n ?? "").trim();
  if (t.length < TERMINAL_REASON_MIN) throw new TerminalError("Escreve o motivo (mín. 3 letras).");
  return t.slice(0, 255);
};

const hm = (v: string | null | undefined) => (v ? lisbonClock(v) : "—");
const span = (a: string | null | undefined, b: string | null | undefined) => `${hm(a)}–${hm(b)}`;

/** Sessão fechada, fora dos meses fechados. */
async function reviewable(deps: TerminalDeps, sessionId: number): Promise<TerminalSessionRow> {
  if (!(await deps.enabled())) throw new TerminalError(OFF_MESSAGE);
  const s = await deps.store.byId(sessionId);
  if (!s) throw new TerminalError("Troço de terminal não encontrado.", "NOT_FOUND");
  if (!s.endedAt) throw new TerminalError("Ainda está no terminal: decide depois de sair.");
  const closed = await closedMonthsOrRefuse(deps);
  const cm = await closedMonthOf(deps, closed, s, [s.countedFrom, s.countedUntil]);
  if (cm) throw new TerminalError(`O ordenado de ${monthLabel(cm)} já está fechado: o terminal desse mês não muda.`);
  return s;
}

/** Não sobrepõe outro troço da mesma cidade (nem da mesma pessoa). */
async function assertNoOverlap(deps: TerminalDeps, s: TerminalSessionRow, fromMs: number, untilMs: number): Promise<void> {
  const fromUtc = toDbUtc(fromMs), toUtc = toDbUtc(untilMs);
  const others = [
    ...(await deps.store.sessionsBetween({ cityKey: s.cityKey, fromUtc, toUtc })),
    ...(await deps.store.sessionsBetween({ employeeId: s.employeeId, fromUtc, toUtc })),
  ];
  const c = overlapConflict({ id: s.id, employeeId: s.employeeId, cityKey: s.cityKey, fromMs, untilMs }, others, deps.now());
  if (c) {
    const who = await nameOf(deps, c.employeeId);
    const where = c.cityKey === s.cityKey ? `no terminal ${TERMINAL_CITY_OF[s.cityKey]}` : `no terminal ${TERMINAL_CITY_OF[c.cityKey as TerminalCityKey] ?? c.cityKey}`;
    throw new TerminalError(`Sobrepõe-se ao troço de ${who} ${where} (${span(c.countedFrom && toMs(c.countedFrom) < toMs(c.startedAt) ? c.countedFrom : c.startedAt, c.endedAt)}). Corrige as horas.`);
  }
}

async function applyReview(deps: TerminalDeps, actor: RhActor, s: TerminalSessionRow, next: { countedFrom: string | null; countedUntil: string | null; countedBasis: "confirmed" | "rejected" }, note: string, action: string): Promise<void> {
  const ok = await deps.store.review(s.id, {
    ...next, reviewedByUserId: actor.userId, reviewedAt: toDbUtc(deps.now()), reviewNote: note,
    autoCountedUntil: s.autoCountedBasis ? (s.autoCountedUntil ?? null) : (s.countedUntil ?? null),
    autoCountedBasis: s.autoCountedBasis ? s.autoCountedBasis : (s.countedBasis ?? "pending"),
  }, { countedBasis: s.countedBasis ?? null, countedUntil: s.countedUntil ?? null });
  if (!ok) throw new TerminalError("Este troço mudou entretanto. Vê outra vez.");
  const name = await nameOf(deps, s.employeeId);
  const before = `${TERMINAL_BASIS_LABELS[(s.countedBasis ?? "pending") as TerminalCountedBasis] ?? s.countedBasis}${s.countedUntil ? ` até ${hm(s.countedUntil)}` : ""}`;
  const after = next.countedBasis === "rejected" ? "desmarcado (não paga terminal)" : `confirmado ${span(next.countedFrom ?? s.startedAt, next.countedUntil)}`;
  await safeLog(deps, {
    userId: actor.userId, action, entityId: s.id,
    details: `Terminal ${TERMINAL_CITY_OF[s.cityKey]} de ${name} (${span(s.startedAt, s.endedAt)}): ${before} → ${after} — ${note}`,
  });
}

/** RH: "Confirmar" — o troço todo conta (do início ao fecho). */
export async function rhConfirm(deps: TerminalDeps, actor: RhActor, o: { sessionId: number; note: string }): Promise<{ message: string }> {
  const note = noteOf(o.note);
  const s = await reviewable(deps, o.sessionId);
  const from = toMs(s.startedAt), until = toMs(s.endedAt!);
  if (!(until > from)) throw new TerminalError("Este troço não tem duração.");
  await assertNoOverlap(deps, s, from, until);
  await applyReview(deps, actor, s, { countedFrom: s.startedAt, countedUntil: s.endedAt, countedBasis: "confirmed" }, note, "terminal_rh_confirm");
  return { message: `Terminal confirmado: ${span(s.startedAt, s.endedAt)}.` };
}

/** Tempo máximo de um troço corrigido (o ponto também corta aos 16 h). */
export const TERMINAL_CORRECT_MAX_HOURS = 16;

/** RH: "Corrigir" — conta de `from` a `until` (UTC "YYYY-MM-DD HH:MM:SS"). */
export async function rhCorrect(deps: TerminalDeps, actor: RhActor, o: { sessionId: number; from: string; until: string; note: string }): Promise<{ message: string }> {
  const note = noteOf(o.note);
  const s = await reviewable(deps, o.sessionId);
  const from = toMs(o.from), until = toMs(o.until);
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) throw new TerminalError("A hora de fim tem de ser depois da de início.");
  if (until > deps.now()) throw new TerminalError("A hora de fim não pode ser no futuro.");
  if (until - from > TERMINAL_CORRECT_MAX_HOURS * 3_600_000) throw new TerminalError(`No máximo ${TERMINAL_CORRECT_MAX_HOURS} h seguidas.`);
  // perto do troço (o mesmo dia de trabalho): até 16 h antes do início e depois do fecho
  const start = toMs(s.startedAt), end = toMs(s.endedAt!);
  if (from < start - TERMINAL_CORRECT_MAX_HOURS * 3_600_000 || until > end + TERMINAL_CORRECT_MAX_HOURS * 3_600_000) throw new TerminalError("As horas estão longe deste troço. Escolhe o troço certo.");
  const closed = await closedMonthsOrRefuse(deps);
  const cm = await closedMonthOf(deps, closed, s, [o.from, o.until]);
  if (cm) throw new TerminalError(`O ordenado de ${monthLabel(cm)} já está fechado: o terminal desse mês não muda.`);
  await assertNoOverlap(deps, s, from, until);
  const f = toDbUtc(from), u = toDbUtc(until);
  await applyReview(deps, actor, s, { countedFrom: f, countedUntil: u, countedBasis: "confirmed" }, note, "terminal_rh_correct");
  return { message: `Terminal corrigido: conta ${span(f, u)}.` };
}

/** RH: "Desmarcar" — nenhuma hora deste troço paga terminal. */
export async function rhReject(deps: TerminalDeps, actor: RhActor, o: { sessionId: number; note: string }): Promise<{ message: string }> {
  const note = noteOf(o.note);
  const s = await reviewable(deps, o.sessionId);
  await applyReview(deps, actor, s, { countedFrom: s.countedFrom ?? null, countedUntil: s.countedUntil ?? null, countedBasis: "rejected" }, note, "terminal_rh_reject");
  return { message: `Terminal desmarcado: ${span(s.startedAt, s.endedAt)} não paga terminal.` };
}

/**
 * Os botões antigos (Confirmar terminal / Desmarcar numa SAÍDA do ponto)
 * passam a atuar nas sessões desse turno: todas as sessões fechadas que tocam
 * [entrada, saída]. Devolve quantas mudaram; nenhuma → erro.
 */
export async function rhSetShift(deps: TerminalDeps, actor: RhActor, o: { employeeId: number; inAt: string; outAt: string; terminal: boolean; note: string }): Promise<{ changed: number; message: string }> {
  if (!(await deps.enabled())) throw new TerminalError(OFF_MESSAGE);
  const note = noteOf(o.note);
  const list = (await deps.store.sessionsBetween({ employeeId: o.employeeId, fromUtc: o.inAt, toUtc: o.outAt }))
    .filter((s) => s.endedAt && toMs(s.startedAt) < toMs(o.outAt) && toMs(s.endedAt) > toMs(o.inAt));
  if (!list.length) throw new TerminalError("Este turno não tem terminal.");
  let changed = 0;
  for (const s of list) {
    if (o.terminal ? s.countedBasis === "confirmed" && s.countedUntil === s.endedAt : s.countedBasis === "rejected") continue;
    if (o.terminal) await rhConfirm(deps, actor, { sessionId: s.id, note });
    else await rhReject(deps, actor, { sessionId: s.id, note });
    changed++;
  }
  return { changed, message: o.terminal ? `Terminal confirmado (${changed} troço${changed === 1 ? "" : "s"}).` : `Terminal desmarcado (${changed} troço${changed === 1 ? "" : "s"}).` };
}

// ─── Atividade diária → Resumo do dia ───────────────────────────────────────

export type DayTimelineItem =
  | {
    kind: "session"; id: number; employeeId: number; name: string; from: string; to: string | null; open: boolean;
    sourceLabel: string; endReasonLabel: string | null; endNote: string | null; countedLabel: string; basis: string | null; payUplift: boolean;
  }
  | { kind: "gap"; from: string; to: string; label: string };

/** Linha do tempo do terminal de uma cidade num dia operacional (03:00 → 03:00). */
export async function terminalDayTimeline(deps: TerminalDeps, o: { date: string; city: TerminalCityKey }): Promise<{ enabled: boolean; date: string; cityKey: TerminalCityKey; cityLabel: string; items: DayTimelineItem[] }> {
  const base = { date: o.date, cityKey: o.city, cityLabel: TERMINAL_CITY_LABELS[o.city] };
  if (!(await deps.enabled())) return { enabled: false, ...base, items: [] };
  const w = operationalDayWindowUtc(o.date);
  const rows = await deps.store.sessionsBetween({ cityKey: o.city, fromUtc: w.start, toUtc: w.end });
  const names = new Map<number, string>();
  for (const r of rows) if (!names.has(r.employeeId)) names.set(r.employeeId, await nameOf(deps, r.employeeId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = cityDayTimeline(rows.map((r) => ({ ...r, name: names.get(r.employeeId) ?? `Ficha ${r.employeeId}` })), w.startMs, w.endMs, deps.now());
  return {
    enabled: true, ...base,
    items: items.map((it): DayTimelineItem => {
      if (it.kind === "gap") return { kind: "gap", from: toDbUtc(it.fromMs), to: toDbUtc(it.toMs), label: it.label };
      const r = byId.get(it.session.id)!;
      return {
        kind: "session", id: r.id, employeeId: r.employeeId, name: it.session.name, from: toDbUtc(it.fromMs), to: it.open ? null : toDbUtc(it.toMs), open: it.open,
        sourceLabel: TERMINAL_START_SOURCE_LABELS[r.startSource] ?? r.startSource,
        endReasonLabel: r.endReason ? TERMINAL_END_REASON_LABELS[r.endReason as TerminalEndReason] ?? r.endReason : null,
        endNote: r.endNote ?? null, countedLabel: countedLabel(r), basis: r.countedBasis ?? null, payUplift: Number(r.payUplift) === 1,
      };
    }),
  };
}

// ─── Repetição automática (daily-ops) ───────────────────────────────────────

export interface TerminalSessionsRetryReport {
  skipped?: "off";
  /** sessões vistas (pending ou só com o último GPS) */
  pending: number;
  /** melhoraram (última recolha/entrega) */
  resolved: number;
  noActions: number;
  noAgent: number;
  readFailed: boolean;
  deferred: number;
  /** em meses fechados (não mexe) */
  closedMonth: number;
}

/**
 * As sessões dos últimos 7 dias "por confirmar" (ou só com o último GPS)
 * voltam a ler a Multipark — UMA leitura para todas — e passam a contar até à
 * última recolha/entrega quando ela é mais tarde (só até ao "fora"
 * confirmado). Nunca por cima do RH; nunca em meses fechados; nada se apaga.
 */
export async function retryPendingTerminalSessions(deps: TerminalDeps, o: {
  deadlineAt: number;
  days?: number;
  read?: TerminalServiceReader;
  agentIdsOf?: (employeeId: number) => Promise<string[]>;
}): Promise<TerminalSessionsRetryReport> {
  const report: TerminalSessionsRetryReport = { pending: 0, resolved: 0, noActions: 0, noAgent: 0, readFailed: false, deferred: 0, closedMonth: 0 };
  if (!(await deps.enabled())) return { ...report, skipped: "off" };
  const since = toDbUtc(deps.now() - (o.days ?? TERMINAL_RETRY_DAYS) * 86_400_000);
  const list = await deps.store.toSettle(since, 200);
  report.pending = list.length;
  if (!list.length) return report;
  let closed: Set<string>;
  try {
    closed = deps.closedMonths ? await deps.closedMonths() : new Set<string>();
  } catch (err) {
    // sem saber que meses estão fechados não se escreve nada: fica para a próxima volta
    console.warn("[terminal] repetição: fechos do ordenado não lidos:", String((err as Error)?.message ?? err).slice(0, 160));
    report.deferred = list.length;
    return report;
  }
  const todo0: TerminalSessionRow[] = [];
  for (const s of list) {
    if (await closedMonthOf(deps, closed, s)) report.closedMonth++;
    else todo0.push(s);
  }
  const { terminalAgentIdsOf, multiparkServiceReader } = await import("./pontoTerminal");
  const agentsOf = o.agentIdsOf ?? terminalAgentIdsOf;
  const ids = new Map<number, string[]>();
  for (const emp of new Set(todo0.map((s) => s.employeeId))) {
    if (Date.now() > o.deadlineAt) break;
    try { ids.set(emp, await agentsOf(emp)); } catch { ids.set(emp, []); }
  }
  type Item = { s: TerminalSessionRow; inAt: string; outAt: string };
  const todo: Item[] = [];
  for (const s of todo0) {
    const a = ids.get(s.employeeId);
    if (a === undefined) { report.deferred++; continue; }
    if (!a.length) { report.noAgent++; continue; }
    const inAt = s.countedFrom ?? s.startedAt;
    const cap = serviceCap({ endedAt: s.endedAt!, outsideSince: s.outsideSince ?? null, outsideCount: s.outsideCount ?? 0 });
    if (!(cap > toMs(inAt))) { report.noActions++; continue; }
    todo.push({ s, inAt, outAt: toDbUtc(cap) });
  }
  if (!todo.length) return report;
  if (Date.now() > o.deadlineAt) { report.deferred += todo.length; return report; }
  const allIds = Array.from(new Set(todo.flatMap((t) => ids.get(t.s.employeeId) ?? [])));
  const from = todo.reduce((m, t) => (t.inAt < m ? t.inAt : m), todo[0].inAt);
  const to = todo.reduce((m, t) => (t.outAt > m ? t.outAt : m), todo[0].outAt);
  const read = o.read ?? multiparkServiceReader(Math.min(15_000, Math.max(2_000, o.deadlineAt - Date.now() - 1_000)));
  let r: Awaited<ReturnType<TerminalServiceReader>>;
  try { r = await read({ userIds: allIds, from, to }); } catch { r = { available: false, code: "QUERY_FAILED", reason: "erro" } as any; }
  if (!r.available) { report.readFailed = true; return report; }
  const rows = r.data.rows;
  const oldest = r.data.truncated && rows.length ? rows[rows.length - 1].at : null;
  const { serviceInstantBelongsTo } = await import("./multiparkDb/movements");
  for (const t of todo) {
    if (Date.now() > o.deadlineAt) { report.deferred++; continue; }
    const mine = new Set(ids.get(t.s.employeeId) ?? []);
    const res = resolveTerminalByLastService({ inAt: t.inAt, outAt: t.outAt, actions: rows.filter((a) => serviceInstantBelongsTo(a, mine)) });
    if (res.status === "partial") {
      const next = { countedUntil: res.terminalUntil, countedBasis: "last_service" as const };
      if (improvesCounted({ countedBasis: t.s.countedBasis ?? "pending", countedUntil: t.s.countedUntil ?? null }, next)) {
        try { if (await deps.store.improveCounted(t.s.id, res.terminalUntil, "last_service")) report.resolved++; } catch { report.deferred++; }
      } else report.noActions++;
    } else if (oldest && t.inAt < oldest) report.deferred++;
    else report.noActions++;
  }
  return report;
}
