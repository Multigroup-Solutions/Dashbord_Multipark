/**
 * Caixa, fase 4 — cruzar com o exterior.
 *
 *  - Cron diário `cash-external` (runCashExternal): as saídas de ontem e
 *    anteontem nos nossos parques → faturas na InvoiceExpress (R19) e
 *    pagamentos online na Stripe (R20), mais os reembolsos e disputas que a
 *    Stripe mostre desde a última corrida. Chaves só de leitura na Vercel;
 *    sem chave, essa parte fica "por configurar" e nada falha.
 *  - Importar extratos em CSV (importStatement): terminal multibanco de um
 *    parque (R30), banco (R31, transferências) e parceiros (R17).
 *
 * Tudo abre, atualiza ou resolve casos na mesma fila da "Correção de caixa"
 * (server/cashSweep.ts applyActions). Nunca escreve na Multipark, na
 * InvoiceExpress nem na Stripe.
 */
import { sql } from "drizzle-orm";
import type { ExternalBooking } from "./multiparkDb/cashExternal";
import type { IxResult } from "./external/invoiceExpress";
import type { StripeEvent, StripePayment } from "./external/stripe";
import {
  invoiceExternalFinding, invoicesToRead, intentsOf, matchBank, matchPartner, matchTpa, parseStatementCsv, stripeExternalFinding, transferMissingFinding,
  type StatementLine,
} from "./cashCheck/externalRules";
import type { Finding } from "./cashCheck/sweepRules";

type Db = { execute: (q: any) => Promise<any> };
const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const lisbonDay = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(ms));

export const IX_MAX_PER_RUN = 250;
export const STRIPE_MAX_PER_RUN = 300;
export const EXTERNAL_CONCURRENCY = 6;
export const STRIPE_EVENTS_DAYS = 3;

/** Corre `fn` sobre `items` com concorrência limitada, parando no prazo. */
async function pool<T, R>(items: readonly T[], deadlineAt: number, fn: (x: T) => Promise<R>): Promise<{ results: Map<T, R>; partial: boolean }> {
  const results = new Map<T, R>();
  let next = 0, partial = false;
  const worker = async () => {
    while (next < items.length) {
      if (Date.now() > deadlineAt - 6_000) { partial = true; return; }
      const x = items[next++];
      results.set(x, await fn(x));
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXTERNAL_CONCURRENCY, items.length) }, worker));
  return { results, partial: partial || results.size < items.length };
}

export interface ExternalReport {
  days: string[]; bookings: number; partial: boolean;
  invoices: { state: "ok" | "not_configured"; read: number; notFound: number; errors: number; findings: number };
  stripe: { state: "ok" | "not_configured" | "not_restricted" | "error"; read: number; events: number; findings: number; detail?: string };
  opened: number; reopened: number; resolved: number;
}

/** Cruzamento diário (D-1 e D-2). */
export async function runCashExternal(o: { deadlineAt: number; nowMs?: number; days?: string[] }): Promise<ExternalReport> {
  const nowMs = o.nowMs ?? Date.now();
  const [sweep, { loadLiveContext }, live, ix, stripe, { lisbonDayRangeUtc }, { planCaseActions }] = await Promise.all([
    import("./cashSweep"), import("./finance/liveBookings"), import("./multiparkDb/cashExternal"),
    import("./external/invoiceExpress"), import("./external/stripe"), import("../shared/lisbonDay"), import("./cashCheck/cases"),
  ]);
  const d = await sweep.database();
  const ctx = await loadLiveContext();
  const parkIds = [...ctx.ourParks.keys()];
  const today = lisbonDay(nowMs);
  const days = o.days ?? [2, 1].map((k) => lisbonDay(Date.parse(`${today}T12:00:00Z`) - k * 86_400_000));
  const range = lisbonDayRangeUtc(days[0], days[days.length - 1]);
  const bookings = new Map<string, ExternalBooking>();
  for (const b of await live.readExternalCheckouts({ parkIds, start: range.start, end: range.end })) bookings.set(b.id, b);

  const rep: ExternalReport = {
    days, bookings: 0, partial: false,
    invoices: { state: ix.ixConfigured() ? "ok" : "not_configured", read: 0, notFound: 0, errors: 0, findings: 0 },
    stripe: { state: stripe.stripeKeyState(), read: 0, events: 0, findings: 0 },
    opened: 0, reopened: 0, resolved: 0,
  };

  // Stripe: reembolsos e disputas recentes → juntar as reservas desses pagamentos.
  let events: StripeEvent[] = [];
  if (rep.stripe.state === "ok") {
    const sinceSec = Math.floor(nowMs / 1000) - STRIPE_EVENTS_DAYS * 86_400;
    const ev = await stripe.stripeRecentEvents(sinceSec);
    if (ev.ok) {
      events = ev.events;
      rep.stripe.events = events.length;
      const intents = [...new Set(events.map((e) => e.paymentIntent).filter((x): x is string => !!x))];
      if (intents.length) for (const b of await live.readBookingsByIntent({ parkIds, intents })) bookings.set(b.id, b);
    } else { rep.stripe.state = "error"; rep.stripe.detail = ev.detail; }
  }
  const list = [...bookings.values()];
  rep.bookings = list.length;

  // R19 — InvoiceExpress.
  const docs = new Map<number, IxResult>();
  if (rep.invoices.state === "ok") {
    const toRead = invoicesToRead(list).slice(0, IX_MAX_PER_RUN);
    const r = await pool(toRead, o.deadlineAt, (x) => ix.ixGetDocument(String(x.id), x.type));
    for (const [x, res] of r.results) {
      docs.set(x.id, res);
      if (res.ok) rep.invoices.read++;
      else if (res.reason === "not_found") rep.invoices.notFound++;
      else rep.invoices.errors++;
    }
    if (r.partial || invoicesToRead(list).length > IX_MAX_PER_RUN) rep.partial = true;
  }

  // R20 — Stripe.
  const payments = new Map<string, StripePayment | null>();
  if (rep.stripe.state === "ok") {
    const intents = [...new Set(list.flatMap((b) => [...intentsOf(b).keys()]))];
    const r = await pool(intents.slice(0, STRIPE_MAX_PER_RUN), o.deadlineAt, (pi) => stripe.stripeGetPayment(pi));
    for (const [pi, res] of r.results) if (res.ok) { payments.set(pi, res.payment); rep.stripe.read++; }
    if (r.partial || intents.length > STRIPE_MAX_PER_RUN) rep.partial = true;
  }

  // Casos: só se avalia (e resolve sozinho) o que foi lido por inteiro.
  const cases = await sweep.loadCases(d, "booking", list.map((b) => b.id));
  const nowDb = utc(nowMs);
  for (const b of list) {
    const findings: Finding[] = [];
    const evaluated = new Set<string>();
    if (rep.invoices.state === "ok") {
      const mine = b.billing.filter((x) => x.emitted && x.invoiceExpressId != null);
      if (mine.every((x) => { const r = docs.get(x.invoiceExpressId!); return r && (r.ok || r.reason === "not_found"); })) evaluated.add("invoice_external");
      const f = invoiceExternalFinding(b, docs);
      if (f) { findings.push(f); rep.invoices.findings++; }
    }
    if (rep.stripe.state === "ok") {
      const intents = [...intentsOf(b).keys()];
      if (intents.every((pi) => payments.has(pi))) evaluated.add("stripe_external");
      const f = stripeExternalFinding(b, payments, events);
      if (f) { findings.push(f); rep.stripe.findings++; }
    }
    if (!findings.length && !(cases.get(b.id) ?? []).some((c) => evaluated.has(c.code))) continue;
    const meta = {
      subjectType: "booking" as const, subjectId: b.id, parkId: b.parkId, projectId: b.parkId ? ctx.ourParks.get(b.parkId) ?? null : null,
      bookingCode: b.code, day: b.checkOut ? lisbonDay(Date.parse(b.checkOut)) : null,
    };
    const r = await sweep.applyActions(d, meta, planCaseActions(cases.get(b.id) ?? [], findings, evaluated), nowDb);
    rep.opened += r.opened; rep.reopened += r.reopened; rep.resolved += r.resolved;
  }
  await d.execute(sql`INSERT INTO cash_external_runs (at, summaryJson) VALUES (${nowDb}, ${JSON.stringify(rep)})`);
  return rep;
}

/** Estado para o ecrã: chaves configuradas e a última corrida. */
export async function externalStatus() {
  const [ix, stripe, sweep] = await Promise.all([import("./external/invoiceExpress"), import("./external/stripe"), import("./cashSweep")]);
  let last: { at: string; summary: ExternalReport | null } | null = null;
  try {
    const d = await sweep.database();
    const r = rowsOf(await d.execute(sql`SELECT DATE_FORMAT(at, '%Y-%m-%d %H:%i:%s') AS at, summaryJson FROM cash_external_runs ORDER BY at DESC, id DESC LIMIT 1`))[0];
    if (r) { let s: ExternalReport | null = null; try { s = JSON.parse(String(r.summaryJson)); } catch { s = null; } last = { at: String(r.at), summary: s }; }
  } catch { last = null; }
  return { invoiceExpress: ix.ixConfigured() ? "ok" : "not_configured", stripe: stripe.stripeKeyState(), last };
}

// ─── Extratos ──────────────────────────────────────────────────────────────

export type StatementKind = "tpa" | "banco" | "parceiro";
export const STATEMENT_KINDS: readonly StatementKind[] = ["tpa", "banco", "parceiro"];

export interface ImportResult {
  ok: true; batchId: number; lines: number; matched: number; casesOpened: number; errors: string[];
  summary: Record<string, unknown>;
}

/**
 * Importa um extrato e cruza-o. TPA: `parkId` obrigatório (um terminal = um
 * parque). Banco: todos os parques do âmbito. Parceiro: `partnerName` só para
 * o texto; as reservas encontram-se pela referência (externa ou código).
 */
export async function importStatement(o: { kind: StatementKind; csv: string; fileName?: string | null; parkId?: string | null; partnerName?: string | null; userId: number }):
  Promise<ImportResult | { ok: false; code: "BAD_REQUEST" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"; message: string }> {
  const parsed = parseStatementCsv(o.csv);
  if (!parsed.lines.length) return { ok: false, code: "BAD_REQUEST", message: parsed.errors[0] ?? "Sem linhas." };
  const [sweep, { parkInScope }, live, { planCaseActions }, { lisbonDayRangeUtc }, { loadLiveContext }, { scopedProjectIds }] = await Promise.all([
    import("./cashSweep"), import("./cashCheck/caseQueries"), import("./multiparkDb/cashExternal"), import("./cashCheck/cases"),
    import("../shared/lisbonDay"), import("./finance/liveBookings"), import("./cityScope"),
  ]);
  const days = parsed.lines.map((l) => l.date).sort();
  const periodStart = days[0], periodEnd = days[days.length - 1];
  const ctx = await loadLiveContext();
  const scoped = scopedProjectIds();
  const parksInScope = [...ctx.ourParks].filter(([, pid]) => scoped === undefined || (pid != null && scoped.includes(pid))).map(([id]) => id);
  let projectId: number | null = null, parkName: string | null = null;
  if (o.kind === "tpa") {
    if (!o.parkId) return { ok: false, code: "BAD_REQUEST", message: "Escolhe o parque do terminal." };
    const sc = await parkInScope(o.parkId);
    if (!sc.ok) return { ok: false, code: "FORBIDDEN", message: sc.message };
    projectId = sc.projectId; parkName = sc.parkName;
  } else if (!parksInScope.length) return { ok: false, code: "FORBIDDEN", message: "Sem parques nas tuas cidades." };

  const d = await sweep.database();
  const nowDb = utc(Date.now());
  const lineState = new Map<number, { state: string; bookingId?: string | null; code?: string | null }>();
  type Subject = { subjectType: "booking" | "tpa"; subjectId: string; parkId: string | null; bookingCode: string | null; day: string | null; findings: Finding[]; code: string };
  const subjects: Subject[] = [];
  let summary: Record<string, unknown> = {};
  try {
    if (o.kind === "tpa") {
      const r = lisbonDayRangeUtc(periodStart, periodEnd);
      const pays = await live.readPaymentsInWindow({ parkIds: [o.parkId!], start: r.start, end: r.end });
      const out = matchTpa({ parkName, lines: parsed.lines, payments: pays });
      for (const x of out) {
        subjects.push({ subjectType: "tpa", subjectId: `${o.parkId}:${x.day}`, parkId: o.parkId!, bookingCode: null, day: x.day, findings: x.finding ? [x.finding] : [], code: "tpa_mismatch" });
        for (const l of parsed.lines) if (l.date === x.day) lineState.set(l.lineNo, { state: x.finding ? "diferenca" : "bate" });
      }
      summary = { days: out.map(({ finding, ...rest }) => ({ ...rest, ok: !finding })) };
    } else if (o.kind === "banco") {
      const r = lisbonDayRangeUtc(periodStart, periodEnd);
      // Transferências registadas desde TRANSFER_DAYS antes do extrato.
      const start = utc(r.startMs - 5 * 86_400_000);
      const pays = await live.readPaymentsInWindow({ parkIds: parksInScope, start, end: r.end });
      const m = matchBank({ lines: parsed.lines, payments: pays, periodStart, periodEnd });
      for (const x of m.matched) lineState.set(x.lineNo, { state: "bate", bookingId: x.bookingId, code: x.code });
      for (const l of m.unmatchedLines) lineState.set(l.lineNo, { state: "sem_reserva" });
      for (const [bookingId, v] of m.missing) {
        subjects.push({ subjectType: "booking", subjectId: bookingId, parkId: v.parkId, bookingCode: v.code, day: null, findings: [transferMissingFinding(v.items)], code: "transfer_missing" });
      }
      summary = { matched: m.matched.length, unmatchedCredits: m.unmatchedLines.length, missingTransfers: m.missing.size };
    } else {
      const refs = parsed.lines.map((l) => l.reference ?? "").filter(Boolean);
      const rows = refs.length ? await live.readPartnerDue({ parkIds: parksInScope, refs }) : [];
      const m = matchPartner({ partnerName: o.partnerName ?? null, lines: parsed.lines, bookings: rows });
      const bad = new Map(m.findings.map((f) => [f.booking.id, f]));
      const byRef = new Map<string, (typeof rows)[number]>();
      for (const b of rows) { if (b.externalReference) byRef.set(b.externalReference.toUpperCase(), b); if (b.code) byRef.set(b.code.toUpperCase(), b); }
      for (const l of parsed.lines) {
        const b = l.reference ? byRef.get(l.reference.trim().toUpperCase()) : undefined;
        lineState.set(l.lineNo, b ? { state: bad.has(b.id) ? "diferenca" : "bate", bookingId: b.id, code: b.code } : { state: l.reference ? "sem_reserva" : "sem_referencia" });
      }
      for (const b of rows) {
        const f = bad.get(b.id);
        subjects.push({ subjectType: "booking", subjectId: b.id, parkId: b.parkId, bookingCode: b.code, day: null, findings: f ? [f.finding] : [], code: "partner_statement" });
      }
      summary = { ok: m.ok, differences: m.findings.length, notFound: m.notFound.length, noReference: m.noReference };
    }
  } catch (err) {
    console.warn("[cash-external] extrato:", (err as Error)?.message);
    return { ok: false, code: "INTERNAL_SERVER_ERROR", message: "BD da Multipark sem resposta: tenta daqui a pouco." };
  }

  // Casos (por tipo de sujeito).
  let casesOpened = 0;
  for (const type of ["booking", "tpa"] as const) {
    const mine = subjects.filter((x) => x.subjectType === type);
    if (!mine.length) continue;
    const existing = await sweep.loadCases(d, type, mine.map((x) => x.subjectId));
    for (const x of mine) {
      const pid = x.parkId ? ctx.ourParks.get(x.parkId) ?? null : projectId;
      const r = await sweep.applyActions(d, { subjectType: type, subjectId: x.subjectId, parkId: x.parkId, projectId: pid, bookingCode: x.bookingCode, day: x.day },
        planCaseActions(existing.get(x.subjectId) ?? [], x.findings, new Set([x.code])), nowDb);
      casesOpened += r.opened + r.reopened;
    }
  }
  await sweep.flushCaseAlerts(d, nowDb);

  const matched = [...lineState.values()].filter((v) => v.state === "bate").length;
  const res: any = await d.execute(sql`INSERT INTO cash_statement_batches (kind, parkId, projectId, partnerName, fileName, periodStart, periodEnd, lineCount, matchedCount, casesOpened, summaryJson, uploadedBy, uploadedAt)
    VALUES (${o.kind}, ${o.kind === "tpa" ? o.parkId! : null}, ${projectId}, ${o.partnerName ?? null}, ${o.fileName ?? null}, ${periodStart}, ${periodEnd}, ${parsed.lines.length}, ${matched}, ${casesOpened},
      ${JSON.stringify({ ...summary, errors: parsed.errors.length })}, ${o.userId}, ${nowDb})`);
  const batchId = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
  for (let i = 0; i < parsed.lines.length; i += 200) {
    const chunk = parsed.lines.slice(i, i + 200);
    await d.execute(sql`INSERT INTO cash_statement_lines (batchId, lineNo, day, amount, reference, description, matchState, bookingId, bookingCode) VALUES ${sql.join(chunk.map((l: StatementLine) => {
      const st = lineState.get(l.lineNo) ?? { state: "por_ver" };
      return sql`(${batchId}, ${l.lineNo}, ${l.date}, ${l.amount}, ${l.reference?.slice(0, 255) ?? null}, ${l.description?.slice(0, 255) ?? null}, ${st.state}, ${st.bookingId ?? null}, ${st.code ?? null})`;
    }), sql`, `)}`);
  }
  return { ok: true, batchId, lines: parsed.lines.length, matched, casesOpened, errors: parsed.errors, summary };
}

/** Extratos importados (âmbito de cidade: os de parque pelo centro; banco e parceiros só a nível nacional). */
export async function listStatements(limit = 30) {
  const [sweep, { projectScope, scopedProjectIds }] = await Promise.all([import("./cashSweep"), import("./cityScope")]);
  const d = await sweep.database();
  const national = scopedProjectIds() === undefined;
  const scope = national ? sql`1 = 1` : projectScope(sql.raw("b.projectId"));
  const rows = rowsOf(await d.execute(sql`SELECT b.id, b.kind, b.parkId, b.partnerName, b.fileName, DATE_FORMAT(b.periodStart, '%Y-%m-%d') AS ps, DATE_FORMAT(b.periodEnd, '%Y-%m-%d') AS pe,
      b.lineCount, b.matchedCount, b.casesOpened, b.summaryJson, DATE_FORMAT(b.uploadedAt, '%Y-%m-%d %H:%i:%s') AS at, u.name AS byName
    FROM cash_statement_batches b LEFT JOIN users u ON u.id = b.uploadedBy WHERE ${scope} ORDER BY b.uploadedAt DESC, b.id DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`));
  return rows.map((r) => {
    let summary: any = null; try { summary = JSON.parse(String(r.summaryJson)); } catch { summary = null; }
    return {
      id: Number(r.id), kind: String(r.kind) as StatementKind, parkId: r.parkId ?? null, partnerName: r.partnerName ?? null, fileName: r.fileName ?? null,
      periodStart: r.ps ?? null, periodEnd: r.pe ?? null, lines: Number(r.lineCount), matched: Number(r.matchedCount), casesOpened: Number(r.casesOpened),
      summary, at: String(r.at), byName: r.byName ?? null,
    };
  });
}

/** Linhas de um extrato (as que não bateram primeiro). */
export async function statementLines(batchId: number) {
  const [sweep, { projectScope, scopedProjectIds }] = await Promise.all([import("./cashSweep"), import("./cityScope")]);
  const d = await sweep.database();
  const national = scopedProjectIds() === undefined;
  const ok = rowsOf(await d.execute(sql`SELECT id FROM cash_statement_batches b WHERE b.id = ${batchId} AND ${national ? sql`1 = 1` : projectScope(sql.raw("b.projectId"))}`)).length > 0;
  if (!ok) return null;
  const rows = rowsOf(await d.execute(sql`SELECT lineNo, DATE_FORMAT(day, '%Y-%m-%d') AS day, amount, reference, description, matchState, bookingId, bookingCode
    FROM cash_statement_lines WHERE batchId = ${batchId} ORDER BY (matchState = 'bate'), lineNo LIMIT 2000`));
  return rows.map((r) => ({
    lineNo: Number(r.lineNo), day: String(r.day), amount: Number(r.amount), reference: r.reference ?? null, description: r.description ?? null,
    state: String(r.matchState), bookingId: r.bookingId ?? null, bookingCode: r.bookingCode ?? null,
  }));
}
