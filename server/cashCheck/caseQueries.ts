/**
 * Caixa, fase 3 (ver, fechar e contar) — leituras e ações dos casos da
 * "Correção de caixa" e da contagem da caixa (R24). Quem chama (router) já
 * verificou a porta (Faturação + totais); aqui aplica-se o âmbito de cidade.
 */
import { sql } from "drizzle-orm";
import type { CaseState } from "./cases";

type Db = { execute: (q: any) => Promise<any> };
const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const DT = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s')`);
const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const SEV_RANK = sql.raw(`CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`);

async function database(): Promise<Db> {
  const { getDb } = await import("../db");
  const d = await getDb();
  if (!d) throw new Error("BD indisponível");
  return d as unknown as Db;
}

// ─── Estados (PURO) ─────────────────────────────────────────────────────────

export type CaseActionKind = "analise" | "fechar" | "reabrir" | "nota";
export const MIN_EXPLANATION = 10;

/** Estado seguinte de uma ação de uma pessoa (ou o erro). PURA. */
export function nextCaseState(state: CaseState, action: CaseActionKind, reason: string | null, explanation: string | null):
  { ok: true; state: CaseState } | { ok: false; message: string } {
  const text = (explanation ?? "").trim();
  switch (action) {
    case "analise":
      return state === "aberto" ? { ok: true, state: "em_analise" } : { ok: false, message: "Só um caso aberto passa a \"em análise\"." };
    case "fechar":
      if (state !== "aberto" && state !== "em_analise") return { ok: false, message: "O caso já não está aberto." };
      if (!reason) return { ok: false, message: "Escolhe o motivo." };
      if (text.length < MIN_EXPLANATION) return { ok: false, message: `A explicação é obrigatória (pelo menos ${MIN_EXPLANATION} carateres).` };
      return { ok: true, state: reason === "perda" ? "perda_aceite" : "justificado" };
    case "reabrir":
      return state === "aberto" || state === "em_analise" ? { ok: false, message: "O caso já está aberto." } : { ok: true, state: "aberto" };
    case "nota":
      return text.length >= 2 ? { ok: true, state } : { ok: false, message: "Escreve a nota." };
  }
}

// ─── Âmbito ─────────────────────────────────────────────────────────────────

async function scopeSql(col: string) {
  const { projectScope } = await import("../cityScope");
  return projectScope(sql.raw(col));
}

// ─── Fila ───────────────────────────────────────────────────────────────────

export async function listCases(f: { view?: "abertos" | "fechados" | "todos"; severity?: string; code?: string; parkId?: string; day?: string; limit?: number; offset?: number }) {
  const d = await database();
  const scope = await scopeSql("c.projectId");
  const view = f.view ?? "abertos";
  const conds = [scope,
    view === "abertos" ? sql`c.state IN ('aberto', 'em_analise')` : view === "fechados" ? sql`c.state NOT IN ('aberto', 'em_analise')` : sql`1 = 1`];
  if (f.severity) conds.push(sql`c.severity = ${f.severity}`);
  if (f.code) conds.push(sql`c.code = ${f.code}`);
  if (f.parkId) conds.push(sql`c.parkId = ${f.parkId}`);
  if (f.day) conds.push(sql`c.day = ${f.day}`);
  const where = sql.join(conds, sql` AND `);
  const limit = Math.min(Math.max(f.limit ?? 50, 10), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const [rows, counts, total] = await Promise.all([
    d.execute(sql`SELECT c.id, c.subjectType, c.subjectId, c.code, c.ruleRef, c.label, c.severity, c.state, c.detail, c.parkId, c.bookingCode,
        DATE_FORMAT(c.day, '%Y-%m-%d') AS day, ${DT("c.openedAt")} AS openedAt, ${DT("c.lastSeenAt")} AS lastSeenAt, ${DT("c.closedAt")} AS closedAt,
        c.closeReason, c.explanation, c.reopenCount, u.name AS closedByName
      FROM cash_cases c LEFT JOIN users u ON u.id = c.closedBy
      WHERE ${where} ORDER BY ${SEV_RANK} DESC, c.lastSeenAt DESC, c.id DESC LIMIT ${limit} OFFSET ${offset}`),
    d.execute(sql`SELECT c.state, c.severity, COUNT(*) AS n FROM cash_cases c WHERE ${scope} GROUP BY c.state, c.severity`),
    d.execute(sql`SELECT COUNT(*) AS n FROM cash_cases c WHERE ${where}`),
  ]);
  let parkName = new Map<string, string>();
  try {
    const { loadLiveContext } = await import("../finance/liveBookings");
    const ctx = await loadLiveContext();
    parkName = new Map([...(ctx.parkInfo ?? new Map()).entries()].map(([id, p]) => [id, p.name]));
  } catch { /* nomes dos parques são um extra */ }
  const byState: Record<string, number> = {};
  const openBySeverity: Record<string, number> = {};
  for (const r of rowsOf(counts)) {
    byState[String(r.state)] = (byState[String(r.state)] ?? 0) + Number(r.n);
    if (r.state === "aberto" || r.state === "em_analise") openBySeverity[String(r.severity)] = (openBySeverity[String(r.severity)] ?? 0) + Number(r.n);
  }
  return {
    total: Number(rowsOf(total)[0]?.n ?? 0), limit, offset, byState, openBySeverity,
    rows: rowsOf(rows).map((r) => ({
      id: Number(r.id), subjectType: String(r.subjectType), subjectId: String(r.subjectId), code: String(r.code), rule: r.ruleRef ?? null,
      label: String(r.label), severity: String(r.severity), state: String(r.state) as CaseState, detail: r.detail ?? null,
      parkId: r.parkId ?? null, parkName: r.parkId ? parkName.get(String(r.parkId)) ?? null : null, bookingCode: r.bookingCode ?? null,
      day: r.day ?? null, openedAt: r.openedAt, lastSeenAt: r.lastSeenAt, closedAt: r.closedAt ?? null, closedByName: r.closedByName ?? null,
      closeReason: r.closeReason ?? null, explanation: r.explanation ?? null, reopenCount: Number(r.reopenCount ?? 0),
    })),
  };
}

// ─── Detalhe ────────────────────────────────────────────────────────────────

/** Campos de preço/método para R9/R25. */
const PRICE_METHOD_FIELDS = new Set(["bookingPrice", "parkingPrice", "deliveryPrice", "discountAmount", "paymentMethod", "paymentSource", "total", "amountPaid", "amount"]);
const MONEY_CODES = new Set(["price_zeroed", "price_after_checkin", "price_after_creation", "lines_below", "method_changed", "paid_mismatch", "discount_late"]);

export interface MoneyHistoryEntry { at: string | null; who: string | null; kindLabel: string; platform: string | null; changes: Array<{ field: string; from: unknown; to: unknown }> }

/** R9 (alteração sem rasto) e R25 (mesma pessoa mexeu e fechou/validou). PURA. */
export function traceFlags(o: { code: string; history: readonly MoneyHistoryEntry[]; closedBy: string | null; validatedBy: string | null }): { noTrace: boolean; samePerson: string | null } {
  const priceMethod = o.history.filter((h) => h.changes.some((c) => PRICE_METHOD_FIELDS.has(c.field)));
  const norm = (v: string | null) => (v ?? "").trim().toLowerCase();
  const closers = [norm(o.closedBy), norm(o.validatedBy)].filter(Boolean);
  const same = priceMethod.find((h) => h.who && closers.includes(norm(h.who)));
  return { noTrace: MONEY_CODES.has(o.code) && priceMethod.length === 0, samePerson: same?.who ?? null };
}

export async function getCaseDetail(id: number, cities: string[] | undefined) {
  const d = await database();
  const scope = await scopeSql("c.projectId");
  const c = rowsOf(await d.execute(sql`SELECT c.*, DATE_FORMAT(c.day, '%Y-%m-%d') AS dayS, ${DT("c.openedAt")} AS openedAtS, ${DT("c.lastSeenAt")} AS lastSeenAtS,
      ${DT("c.closedAt")} AS closedAtS, u.name AS closedByName
    FROM cash_cases c LEFT JOIN users u ON u.id = c.closedBy WHERE c.id = ${id} AND ${scope} LIMIT 1`))[0];
  if (!c) return null;
  const events = rowsOf(await d.execute(sql`SELECT e.id, ${DT("e.at")} AS at, e.action, e.note, u.name AS byName FROM cash_case_events e
    LEFT JOIN users u ON u.id = e.userId WHERE e.caseId = ${id} ORDER BY e.at DESC, e.id DESC LIMIT 200`));
  const base = {
    id: Number(c.id), subjectType: String(c.subjectType), subjectId: String(c.subjectId), code: String(c.code), rule: c.ruleRef ?? null,
    label: String(c.label), severity: String(c.severity), state: String(c.state) as CaseState, detail: c.detail ?? null, parkId: c.parkId ?? null,
    bookingCode: c.bookingCode ?? null, day: c.dayS ?? null, openedAt: c.openedAtS, lastSeenAt: c.lastSeenAtS, closedAt: c.closedAtS ?? null,
    closedByName: c.closedByName ?? null, closeReason: c.closeReason ?? null, explanation: c.explanation ?? null, reopenCount: Number(c.reopenCount ?? 0),
    events: events.map((e) => ({ id: Number(e.id), at: e.at, action: String(e.action), note: e.note ?? null, byName: e.byName ?? null })),
  };
  if (base.subjectType !== "booking") return { ...base, booking: null };

  // Reserva: dinheiro agora, retratos (webhook + varredura), era/é e quem mexeu no dinheiro.
  const bookingId = base.subjectId;
  const [{ safeMultiparkRead }, { readLiveFinanceByIds }, { getBookingFileTimeline }, { listMemoryForBookings }, rules] = await Promise.all([
    import("../multiparkDb/read"), import("../multiparkDb/cashCheck"), import("../multiparkDb/bookingFile"), import("../webhookMemory"), import("./rules"),
  ]);
  const liveR = await safeMultiparkRead("caixa/caso", async () => (await readLiveFinanceByIds([bookingId], cities))[0] ?? null);
  const live = liveR.available ? liveR.data : null;
  const memory = (await listMemoryForBookings([bookingId]).catch(() => new Map())).get(bookingId) ?? [];
  const snaps = rowsOf(await d.execute(sql`SELECT ${DT("capturedAt")} AS at, snapJson FROM cash_live_snapshots WHERE bookingExternalId = ${bookingId} ORDER BY capturedAt, id LIMIT 200`))
    .map((r) => { try { return JSON.parse(String(r.snapJson)); } catch { return null; } }).filter(Boolean);
  const era = [...memory, ...snaps];
  const tl = await getBookingFileTimeline(bookingId, cities);
  const history: MoneyHistoryEntry[] = tl.available
    ? tl.data.entries.map((e) => ({ at: e.at, who: e.who, kindLabel: e.kindLabel, platform: e.platform, changes: e.changes.filter((ch) => rules.MONEY_HISTORY_FIELDS.has(ch.field)) }))
      .filter((e) => e.changes.length > 0)
    : [];
  const flags = tl.available ? traceFlags({ code: base.code, history, closedBy: live?.cashierClosed.by ?? null, validatedBy: live?.cashValidated.by ?? null }) : null;
  return {
    ...base,
    booking: {
      id: bookingId,
      live: liveR.available ? live : null,
      liveUnavailable: liveR.available ? null : liveR.reason,
      rows: rules.eraRows(era, live),
      snapshots: snaps.map((x: any) => ({ at: x.receivedAt, status: x.status, bookingPrice: x.bookingPrice, linesTotal: x.linesTotal, paymentsTotal: x.paymentsTotal, paymentMethod: x.paymentMethod, cashierClosed: x.cashierClosed })),
      memoryCount: memory.length,
      history,
      historyUnavailable: tl.available ? null : tl.reason,
      flags,
    },
  };
}

// ─── Ações ──────────────────────────────────────────────────────────────────

const REASON_LABEL: Record<string, string> = {
  desconto_autorizado: "desconto autorizado", erro_corrigido: "erro de introdução corrigido", cortesia: "cortesia",
  pago_noutro_canal: "pago noutro canal", parceiro_ou_pro: "parceiro ou Pro (fatura à parte)", perda: "perda aceite", outro: "outro",
};

export async function applyCaseAction(o: { id: number; action: CaseActionKind; reason: string | null; explanation: string | null; userId: number }):
  Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "BAD_REQUEST"; message: string }> {
  const d = await database();
  const scope = await scopeSql("c.projectId");
  const c = rowsOf(await d.execute(sql`SELECT c.id, c.state FROM cash_cases c WHERE c.id = ${o.id} AND ${scope} LIMIT 1`))[0];
  if (!c) return { ok: false, code: "NOT_FOUND", message: "Caso não encontrado (ou fora das tuas cidades)." };
  const next = nextCaseState(c.state as CaseState, o.action, o.reason, o.explanation);
  if (!next.ok) return { ok: false, code: "BAD_REQUEST", message: next.message };
  const now = utcNow();
  const text = (o.explanation ?? "").trim() || null;
  if (o.action === "fechar") {
    await d.execute(sql`UPDATE cash_cases SET state = ${next.state}, closedAt = ${now}, closedBy = ${o.userId}, closeReason = ${o.reason}, explanation = ${text} WHERE id = ${o.id}`);
  } else if (o.action === "reabrir") {
    await d.execute(sql`UPDATE cash_cases SET state = 'aberto', closedAt = NULL, resolvedAt = NULL, reopenCount = reopenCount + 1 WHERE id = ${o.id}`);
  } else if (o.action === "analise") {
    await d.execute(sql`UPDATE cash_cases SET state = 'em_analise' WHERE id = ${o.id}`);
  }
  const action = o.action === "fechar" ? `fechado: ${REASON_LABEL[o.reason ?? "outro"] ?? o.reason}` : o.action === "analise" ? "em análise" : o.action === "reabrir" ? "reaberto à mão" : "nota";
  await d.execute(sql`INSERT INTO cash_case_events (caseId, at, userId, action, note) VALUES (${o.id}, ${now}, ${o.userId}, ${action.slice(0, 24)}, ${text})`);
  return { ok: true };
}

// ─── Contagem da caixa (R24) ────────────────────────────────────────────────

async function parkInScope(parkId: string): Promise<{ ok: true; projectId: number | null; parkName: string | null } | { ok: false; message: string }> {
  const [{ loadLiveContext }, { scopedProjectIds }] = await Promise.all([import("../finance/liveBookings"), import("../cityScope")]);
  const ctx = await loadLiveContext();
  if (!ctx.ourParks.has(parkId)) return { ok: false, message: "Esse parque não é nosso." };
  const projectId = ctx.ourParks.get(parkId) ?? null;
  const scoped = scopedProjectIds();
  if (scoped !== undefined && (projectId == null || !scoped.includes(projectId))) return { ok: false, message: "Esse parque não é das tuas cidades." };
  return { ok: true, projectId, parkName: ctx.parkInfo?.get(parkId)?.name ?? null };
}

async function receivedCash(parkId: string, day: string): Promise<{ amount: number; count: number }> {
  const [{ lisbonDayRangeUtc }, { readCashReceived }] = await Promise.all([import("../../shared/lisbonDay"), import("../multiparkDb/cashSweep")]);
  const r = lisbonDayRangeUtc(day);
  return (await readCashReceived({ parkIds: [parkId], start: r.start, end: r.end })).get(parkId) ?? { amount: 0, count: 0 };
}

export async function getCountDay(parkId: string, day: string) {
  const scope = await parkInScope(parkId);
  if (!scope.ok) return { available: false as const, reason: scope.message };
  const d = await database();
  let received: { amount: number; count: number } | null = null;
  let receivedError: string | null = null;
  try { received = await receivedCash(parkId, day); } catch (err) { receivedError = "BD da Multipark sem resposta: não dá para calcular o recebido em dinheiro."; }
  const count = rowsOf(await d.execute(sql`SELECT c.*, ${DT("c.countedAt")} AS countedAtS, u.name AS byName FROM cash_counts c LEFT JOIN users u ON u.id = c.countedBy
    WHERE c.parkId = ${parkId} AND c.day = ${day} AND c.shift = 'dia' LIMIT 1`))[0] ?? null;
  const expenses = count ? rowsOf(await d.execute(sql`SELECT id, description, amount, receipt FROM cash_count_expenses WHERE countId = ${count.id} ORDER BY id`)) : [];
  const log = count ? rowsOf(await d.execute(sql`SELECT ${DT("l.at")} AS at, l.dataJson, u.name AS byName FROM cash_count_log l LEFT JOIN users u ON u.id = l.userId
    WHERE l.countId = ${count.id} ORDER BY l.at DESC, l.id DESC LIMIT 20`)) : [];
  return {
    available: true as const, parkId, parkName: scope.parkName, day,
    received, receivedError,
    count: count ? {
      id: Number(count.id), counted: Number(count.countedAmount), received: Number(count.receivedCash), expenses: Number(count.expensesCash),
      expected: Number(count.expectedCash), difference: Number(count.difference), note: count.note ?? null, countedAt: count.countedAtS, byName: count.byName ?? null,
    } : null,
    expenses: expenses.map((e) => ({ id: Number(e.id), description: String(e.description), amount: Number(e.amount), receipt: e.receipt ?? null })),
    log: log.map((l) => { let data: any = null; try { data = JSON.parse(String(l.dataJson)); } catch { data = null; } return { at: l.at, byName: l.byName ?? null, counted: data?.counted ?? null, expected: data?.expected ?? null, difference: data?.difference ?? null }; }),
  };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export async function saveCount(o: { parkId: string; day: string; counted: number; note?: string; expenses: Array<{ description: string; amount: number; receipt?: string }>; userId: number }):
  Promise<{ ok: true; expected: number; difference: number; caseOpened: boolean } | { ok: false; code: "FORBIDDEN" | "INTERNAL_SERVER_ERROR"; message: string }> {
  const scope = await parkInScope(o.parkId);
  if (!scope.ok) return { ok: false, code: "FORBIDDEN", message: scope.message };
  let received: { amount: number };
  try { received = await receivedCash(o.parkId, o.day); } catch { return { ok: false, code: "INTERNAL_SERVER_ERROR", message: "BD da Multipark sem resposta: tenta daqui a pouco." }; }
  const d = await database();
  const expenses = r2(o.expenses.reduce((s, e) => s + e.amount, 0));
  const expected = r2(received.amount - expenses);
  const difference = r2(o.counted - expected);
  const now = utcNow();
  await d.execute(sql`INSERT INTO cash_counts (parkId, projectId, day, shift, receivedCash, expensesCash, expectedCash, countedAmount, difference, note, countedBy, countedAt)
    VALUES (${o.parkId}, ${scope.projectId}, ${o.day}, 'dia', ${received.amount}, ${expenses}, ${expected}, ${o.counted}, ${difference}, ${o.note ?? null}, ${o.userId}, ${now})
    ON DUPLICATE KEY UPDATE projectId = VALUES(projectId), receivedCash = VALUES(receivedCash), expensesCash = VALUES(expensesCash), expectedCash = VALUES(expectedCash),
      countedAmount = VALUES(countedAmount), difference = VALUES(difference), note = VALUES(note), countedBy = VALUES(countedBy), countedAt = VALUES(countedAt)`);
  const countId = Number(rowsOf(await d.execute(sql`SELECT id FROM cash_counts WHERE parkId = ${o.parkId} AND day = ${o.day} AND shift = 'dia' LIMIT 1`))[0]?.id);
  // Os gastos desta contagem passam a ser os gravados agora (o registo guarda cada versão).
  await d.execute(sql`DELETE FROM cash_count_expenses WHERE countId = ${countId}`);
  for (const e of o.expenses) {
    await d.execute(sql`INSERT INTO cash_count_expenses (countId, description, amount, receipt, createdBy, createdAt) VALUES (${countId}, ${e.description}, ${e.amount}, ${e.receipt ?? null}, ${o.userId}, ${now})`);
  }
  await d.execute(sql`INSERT INTO cash_count_log (countId, userId, at, dataJson) VALUES (${countId}, ${o.userId}, ${now},
    ${JSON.stringify({ counted: o.counted, received: received.amount, expenses, expected, difference, note: o.note ?? null, lines: o.expenses })})`);
  // R24: caso da contagem (abre, atualiza ou resolve).
  const [{ countFinding }, { planCaseActions }, sweep] = await Promise.all([import("./sweepRules"), import("./cases"), import("../cashSweep")]);
  const f = countFinding({ parkName: scope.parkName, day: o.day, shift: "dia", received: received.amount, expenses, counted: o.counted });
  const subjectId = `${o.parkId}:${o.day}:dia`;
  const existing = (await sweep.loadCases(d, "count", [subjectId])).get(subjectId) ?? [];
  const r = await sweep.applyActions(d, { subjectType: "count", subjectId, parkId: o.parkId, projectId: scope.projectId, bookingCode: null, day: o.day },
    planCaseActions(existing, f ? [f] : [], new Set(["count_mismatch"])), now);
  await sweep.flushCaseAlerts(d, now);
  return { ok: true, expected, difference, caseOpened: r.opened + r.reopened > 0 };
}
