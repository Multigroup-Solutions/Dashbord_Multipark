/**
 * Caixa, fase 4 — confirmar o que não é dinheiro.
 *
 *  - Cron diário `cash-external` (runCashExternal), saídas de ontem e
 *    anteontem nos nossos parques:
 *      · sempre: pago online → a Multipark tem o pagamento Stripe (R20);
 *      · interruptores (Definições → Automações, desligados por omissão):
 *        Stripe (CASH_STRIPE_CHECK), Viva Wallet (CASH_VIVA_CHECK),
 *        InvoiceExpress (CASH_INVOICEXPRESS_CHECK). Sem chave, nada falha.
 *  - Multibanco do dia (R30): o talão fotografado na contagem da caixa liga-se
 *    ao pagamento pelo valor; quem conta confirma o dia. Ou o CSV da Viva.
 *  - Recebimentos mensais (R17): Pro, agentes e agregadores pagam no fim do
 *    mês por transferência; quem confere regista o valor e o comprovativo.
 *
 * Tudo abre, atualiza ou resolve casos na mesma fila da "Correção de caixa".
 * Nunca escreve na Multipark nem nos serviços externos. Nada se apaga.
 */
import { sql } from "drizzle-orm";
import type { ExternalBooking, RecordedPayment } from "./multiparkDb/cashExternal";
import type { IxResult } from "./external/invoiceExpress";
import type { StripeEvent, StripePayment } from "./external/stripe";
import type { VivaTxn } from "./external/vivaWallet";
import {
  invoiceExternalFinding, invoicesToRead, intentsOf, lisbonDayOf, matchMbReceipts, matchViva, mbDayFinding, monthlyKindOf, monthlyReceiptFinding,
  onlineNoIntentFinding, parseVivaCsv, stripeExternalFinding, vivaMissingFinding, MONTHLY_LABEL, type MonthlyKind,
} from "./cashCheck/externalRules";
import type { Finding } from "./cashCheck/sweepRules";

type Db = { execute: (q: any) => Promise<any> };
const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const lisbonDay = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(ms));
const r2 = (v: number) => Math.round(v * 100) / 100;

export const IX_MAX_PER_RUN = 250;
export const STRIPE_MAX_PER_RUN = 300;
export const EXTERNAL_CONCURRENCY = 6;
export const STRIPE_EVENTS_DAYS = 3;

/** Interruptores (Definições → Automações), desligados por omissão. */
export async function cashFlags(): Promise<{ stripe: boolean; viva: boolean; invoiceExpress: boolean }> {
  const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
  await ensureFeatureFlagOverrides();
  const on = (n: string) => isFeatureEnabled(n, { defaultEnabled: automationFlagDefault(n) });
  return { stripe: on("CASH_STRIPE_CHECK"), viva: on("CASH_VIVA_CHECK"), invoiceExpress: on("CASH_INVOICEXPRESS_CHECK") };
}

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

type SourceState = "off" | "ok" | "not_configured" | "not_restricted" | "error";
export interface ExternalReport {
  days: string[]; bookings: number; partial: boolean;
  online: { findings: number };
  invoices: { state: SourceState; read: number; notFound: number; errors: number; findings: number };
  stripe: { state: SourceState; read: number; events: number; findings: number; detail?: string };
  viva: { state: SourceState; txns: number; matched: number; findings: number; detail?: string };
  opened: number; reopened: number; resolved: number;
}

/** Cruzamento diário (D-1 e D-2). */
export async function runCashExternal(o: { deadlineAt: number; nowMs?: number; days?: string[] }): Promise<ExternalReport> {
  const nowMs = o.nowMs ?? Date.now();
  const [sweep, { loadLiveContext }, live, ix, stripe, viva, { lisbonDayRangeUtc }, { planCaseActions }, flags] = await Promise.all([
    import("./cashSweep"), import("./finance/liveBookings"), import("./multiparkDb/cashExternal"),
    import("./external/invoiceExpress"), import("./external/stripe"), import("./external/vivaWallet"), import("../shared/lisbonDay"), import("./cashCheck/cases"),
    cashFlags(),
  ]);
  const d = await sweep.database();
  const ctx = await loadLiveContext();
  const parkIds = [...ctx.ourParks.keys()];
  const today = lisbonDay(nowMs);
  const days = o.days ?? [2, 1].map((k) => lisbonDay(Date.parse(`${today}T12:00:00Z`) - k * 86_400_000));
  const range = lisbonDayRangeUtc(days[0], days[days.length - 1]);
  const bookings = new Map<string, ExternalBooking>();
  for (const b of await live.readExternalCheckouts({ parkIds, start: range.start, end: range.end })) bookings.set(b.id, b);

  const keyState = (on: boolean, s: string): SourceState => (!on ? "off" : s === "ok" ? "ok" : (s as SourceState));
  const rep: ExternalReport = {
    days, bookings: 0, partial: false, online: { findings: 0 },
    invoices: { state: keyState(flags.invoiceExpress, ix.ixConfigured() ? "ok" : "not_configured"), read: 0, notFound: 0, errors: 0, findings: 0 },
    stripe: { state: keyState(flags.stripe, stripe.stripeKeyState()), read: 0, events: 0, findings: 0 },
    viva: { state: keyState(flags.viva, viva.vivaConfigured() ? "ok" : "not_configured"), txns: 0, matched: 0, findings: 0 },
    opened: 0, reopened: 0, resolved: 0,
  };

  // Stripe: reembolsos e disputas recentes → juntar as reservas desses pagamentos.
  let events: StripeEvent[] = [];
  if (rep.stripe.state === "ok") {
    const ev = await stripe.stripeRecentEvents(Math.floor(nowMs / 1000) - STRIPE_EVENTS_DAYS * 86_400);
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
    const all = invoicesToRead(list);
    const r = await pool(all.slice(0, IX_MAX_PER_RUN), o.deadlineAt, (x) => ix.ixGetDocument(String(x.id), x.type));
    for (const [x, res] of r.results) {
      docs.set(x.id, res);
      if (res.ok) rep.invoices.read++;
      else if (res.reason === "not_found") rep.invoices.notFound++;
      else rep.invoices.errors++;
    }
    if (r.partial || all.length > IX_MAX_PER_RUN) rep.partial = true;
  }

  // R20 — Stripe.
  const payments = new Map<string, StripePayment | null>();
  if (rep.stripe.state === "ok") {
    const intents = [...new Set(list.flatMap((b) => [...intentsOf(b).keys()]))];
    const r = await pool(intents.slice(0, STRIPE_MAX_PER_RUN), o.deadlineAt, (pi) => stripe.stripeGetPayment(pi));
    for (const [pi, res] of r.results) if (res.ok) { payments.set(pi, res.payment); rep.stripe.read++; }
    if (r.partial || intents.length > STRIPE_MAX_PER_RUN) rep.partial = true;
  }

  // R30 — Viva Wallet: multibanco registado nesses dias contra o terminal (dia e dia seguinte).
  const vivaMissing = new Map<string, Finding>();
  const vivaSubjects = new Map<string, { code: string | null; parkId: string | null }>();
  let vivaRead = false;
  if (rep.viva.state === "ok") {
    const txDays = [...days, lisbonDay(Date.parse(`${days[days.length - 1]}T12:00:00Z`) + 86_400_000)];
    const txns: VivaTxn[] = [];
    let failed: string | null = null;
    for (const day of txDays) {
      const r = await viva.vivaTransactionsOfDay(day);
      if (r.ok) txns.push(...r.txns); else { failed = r.detail; break; }
    }
    if (failed) { rep.viva.state = "error"; rep.viva.detail = failed; }
    else {
      vivaRead = true;
      rep.viva.txns = txns.length;
      const pays = await live.readPaymentsInWindow({ parkIds, start: range.start, end: range.end });
      const m = matchViva({ payments: pays, txns, days });
      rep.viva.matched = m.matched.length;
      for (const p of pays) vivaSubjects.set(p.bookingId, { code: p.code, parkId: p.parkId });
      for (const [bookingId, v] of m.missing) vivaMissing.set(bookingId, vivaMissingFinding(v.items));
      rep.viva.findings = vivaMissing.size;
    }
  }

  // Casos: só se avalia (e resolve sozinho) o que foi lido por inteiro.
  const subjects = new Set([...list.map((b) => b.id), ...vivaSubjects.keys()]);
  const cases = await sweep.loadCases(d, "booking", [...subjects]);
  const nowDb = utc(nowMs);
  for (const id of subjects) {
    const b = bookings.get(id);
    const findings: Finding[] = [];
    const evaluated = new Set<string>();
    if (b) {
      evaluated.add("online_no_intent");
      const on = onlineNoIntentFinding(b);
      if (on) { findings.push(on); rep.online.findings++; }
      if (rep.invoices.state === "ok") {
        const mine = b.billing.filter((x) => x.emitted && x.invoiceExpressId != null);
        if (mine.every((x) => { const r = docs.get(x.invoiceExpressId!); return r && (r.ok || r.reason === "not_found"); })) evaluated.add("invoice_external");
        const f = invoiceExternalFinding(b, docs);
        if (f) { findings.push(f); rep.invoices.findings++; }
      }
      if (rep.stripe.state === "ok") {
        if ([...intentsOf(b).keys()].every((pi) => payments.has(pi))) evaluated.add("stripe_external");
        const f = stripeExternalFinding(b, payments, events);
        if (f) { findings.push(f); rep.stripe.findings++; }
      }
    }
    if (vivaRead && vivaSubjects.has(id)) {
      evaluated.add("mb_unconfirmed");
      const f = vivaMissing.get(id);
      if (f) findings.push(f);
    }
    if (!findings.length && !(cases.get(id) ?? []).some((c) => evaluated.has(c.code))) continue;
    const v = vivaSubjects.get(id);
    const parkId = b?.parkId ?? v?.parkId ?? null;
    const meta = {
      subjectType: "booking" as const, subjectId: id, parkId, projectId: parkId ? ctx.ourParks.get(parkId) ?? null : null,
      bookingCode: b?.code ?? v?.code ?? null, day: b?.checkOut ? lisbonDay(Date.parse(b.checkOut)) : null,
    };
    const r = await sweep.applyActions(d, meta, planCaseActions(cases.get(id) ?? [], findings, evaluated), nowDb);
    rep.opened += r.opened; rep.reopened += r.reopened; rep.resolved += r.resolved;
  }
  await d.execute(sql`INSERT INTO cash_external_runs (at, summaryJson) VALUES (${nowDb}, ${JSON.stringify(rep)})`);
  return rep;
}

/** Estado para o ecrã: interruptores, chaves (só se existem) e a última corrida. */
export async function externalStatus() {
  const [ix, stripe, viva, sweep, flags] = await Promise.all([import("./external/invoiceExpress"), import("./external/stripe"), import("./external/vivaWallet"), import("./cashSweep"), cashFlags()]);
  let last: { at: string; summary: ExternalReport | null } | null = null;
  try {
    const d = await sweep.database();
    const r = rowsOf(await d.execute(sql`SELECT DATE_FORMAT(at, '%Y-%m-%d %H:%i:%s') AS at, summaryJson FROM cash_external_runs ORDER BY at DESC, id DESC LIMIT 1`))[0];
    if (r) { let s: ExternalReport | null = null; try { s = JSON.parse(String(r.summaryJson)); } catch { s = null; } last = { at: String(r.at), summary: s }; }
  } catch { last = null; }
  return {
    stripe: { on: flags.stripe, key: stripe.stripeKeyState() },
    viva: { on: flags.viva, key: viva.vivaConfigured() ? "ok" : "not_configured" },
    invoiceExpress: { on: flags.invoiceExpress, key: ix.ixConfigured() ? "ok" : "not_configured" },
    last,
  };
}

// ─── Ficheiros (fotos dos talões, comprovativos) ───────────────────────────

export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;

async function storeFile(prefix: string, base64: string, mimeType: string): Promise<{ key: string; url: string }> {
  if (!ALLOWED_MIME.test(mimeType)) throw new Error("Tipo de ficheiro não aceite (foto ou PDF).");
  const buf = Buffer.from(base64, "base64");
  if (!buf.length || buf.length > PHOTO_MAX_BYTES) throw new Error("Ficheiro vazio ou maior do que 8 MB.");
  const { storagePut } = await import("./storage");
  const ext = mimeType === "application/pdf" ? "pdf" : mimeType.split("/")[1] ?? "jpg";
  const key = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { url } = await storagePut(key, buf, mimeType);
  return { key, url };
}

async function fileUrl(key: string | null, url: string | null): Promise<string | null> {
  if (!key) return url;
  try {
    const { storagePresignGet } = await import("./storage");
    return (await storagePresignGet(key))?.url ?? url;
  } catch { return url; }
}

// ─── Multibanco do dia (talões) ────────────────────────────────────────────

type Fail = { ok: false; code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "INTERNAL_SERVER_ERROR"; message: string };

async function mbPaymentsOf(parkId: string, day: string): Promise<RecordedPayment[]> {
  const [{ lisbonDayRangeUtc }, live, { methodKind }] = await Promise.all([import("../shared/lisbonDay"), import("./multiparkDb/cashExternal"), import("./cashCheck/externalRules")]);
  const r = lisbonDayRangeUtc(day);
  return (await live.readPaymentsInWindow({ parkIds: [parkId], start: r.start, end: r.end })).filter((p) => methodKind(p.method) === "card" && p.amount > 0);
}

async function mbReceiptsOf(d: Db, parkId: string, day: string) {
  return rowsOf(await d.execute(sql`SELECT r.id, r.amount, r.bookingId, r.photoKey, r.photoUrl, r.note, DATE_FORMAT(r.uploadedAt, '%Y-%m-%d %H:%i:%s') AS at, u.name AS byName
    FROM cash_mb_receipts r LEFT JOIN users u ON u.id = r.uploadedBy WHERE r.parkId = ${parkId} AND r.day = ${day} AND r.removedAt IS NULL ORDER BY r.id LIMIT 500`));
}

/** Parque + dia: pagamentos por multibanco (Multipark ao vivo), talões e o que casou. */
export async function getMbDay(parkId: string, day: string) {
  const { parkInScope } = await import("./cashCheck/caseQueries");
  const scope = await parkInScope(parkId);
  if (!scope.ok) return { available: false as const, reason: scope.message };
  const sweep = await import("./cashSweep");
  const d = await sweep.database();
  let payments: RecordedPayment[] = [];
  let paymentsError: string | null = null;
  try { payments = await mbPaymentsOf(parkId, day); } catch { paymentsError = "BD da Multipark sem resposta: não dá para ler os pagamentos por multibanco."; }
  const receipts = await mbReceiptsOf(d, parkId, day);
  const m = matchMbReceipts({ payments, receipts: receipts.map((r) => ({ id: Number(r.id), amount: Number(r.amount), bookingId: r.bookingId ?? null })) });
  const confirmed = rowsOf(await d.execute(sql`SELECT c.unmatched, c.extraReceipts, DATE_FORMAT(c.confirmedAt, '%Y-%m-%d %H:%i:%s') AS at, u.name AS byName
    FROM cash_mb_days c LEFT JOIN users u ON u.id = c.confirmedBy WHERE c.parkId = ${parkId} AND c.day = ${day} LIMIT 1`))[0] ?? null;
  const receiptOut = await Promise.all(receipts.map(async (r) => ({
    id: Number(r.id), amount: Number(r.amount), bookingId: r.bookingId ?? null, note: r.note ?? null, at: String(r.at), byName: r.byName ?? null,
    photoUrl: await fileUrl(r.photoKey ?? null, r.photoUrl ?? null), matched: !m.extraReceipts.some((x) => x.id === Number(r.id)),
  })));
  return {
    available: true as const, parkId, parkName: scope.parkName, day, paymentsError,
    payments: payments.map((p, i) => ({ bookingId: p.bookingId, code: p.code, amount: p.amount, method: p.method, recordedAt: p.recordedAt, receiptId: m.byPayment.get(i) ?? null })),
    receipts: receiptOut,
    total: r2(payments.reduce((s, p) => s + p.amount, 0)),
    confirmed: confirmed ? { at: String(confirmed.at), byName: confirmed.byName ?? null, unmatched: Number(confirmed.unmatched), extraReceipts: Number(confirmed.extraReceipts) } : null,
  };
}

/** Reavalia o caso do dia (só depois de alguém o ter confirmado uma vez). */
async function evaluateMbDay(d: Db, o: { parkId: string; day: string; projectId: number | null; parkName: string | null; userId: number | null; confirm: boolean }) {
  const payments = await mbPaymentsOf(o.parkId, o.day);
  const receipts = (await mbReceiptsOf(d, o.parkId, o.day)).map((r) => ({ id: Number(r.id), amount: Number(r.amount), bookingId: r.bookingId ?? null }));
  const m = matchMbReceipts({ payments, receipts });
  const nowDb = utc(Date.now());
  if (o.confirm) {
    await d.execute(sql`INSERT INTO cash_mb_days (parkId, projectId, day, payments, unmatched, extraReceipts, confirmedBy, confirmedAt)
      VALUES (${o.parkId}, ${o.projectId}, ${o.day}, ${payments.length}, ${m.unmatchedPayments.length}, ${m.extraReceipts.length}, ${o.userId}, ${nowDb})
      ON DUPLICATE KEY UPDATE payments = VALUES(payments), unmatched = VALUES(unmatched), extraReceipts = VALUES(extraReceipts), confirmedBy = VALUES(confirmedBy), confirmedAt = VALUES(confirmedAt)`);
  } else if (!rowsOf(await d.execute(sql`SELECT id FROM cash_mb_days WHERE parkId = ${o.parkId} AND day = ${o.day} LIMIT 1`)).length) {
    return { unmatched: m.unmatchedPayments.length, extra: m.extraReceipts.length, caseOpened: false };
  }
  const [sweep, { planCaseActions }] = await Promise.all([import("./cashSweep"), import("./cashCheck/cases")]);
  const f = mbDayFinding({ parkName: o.parkName, day: o.day, unmatchedPayments: m.unmatchedPayments, extraReceipts: m.extraReceipts });
  const subjectId = `${o.parkId}:${o.day}`;
  const existing = (await sweep.loadCases(d, "mb_dia", [subjectId])).get(subjectId) ?? [];
  const r = await sweep.applyActions(d, { subjectType: "mb_dia", subjectId, parkId: o.parkId, projectId: o.projectId, bookingCode: null, day: o.day },
    planCaseActions(existing, f ? [f] : [], new Set(["mb_unconfirmed"])), nowDb);
  await sweep.flushCaseAlerts(d, nowDb);
  return { unmatched: m.unmatchedPayments.length, extra: m.extraReceipts.length, caseOpened: r.opened + r.reopened > 0 };
}

export async function addMbReceipt(o: { parkId: string; day: string; amount: number; bookingId?: string | null; note?: string | null; photoBase64?: string | null; mimeType?: string | null; userId: number }): Promise<{ ok: true; id: number } | Fail> {
  const { parkInScope } = await import("./cashCheck/caseQueries");
  const scope = await parkInScope(o.parkId);
  if (!scope.ok) return { ok: false, code: "FORBIDDEN", message: scope.message };
  let file: { key: string; url: string } | null = null;
  if (o.photoBase64) {
    try { file = await storeFile(`cash/mb/${o.parkId}/${o.day}/talao`, o.photoBase64, o.mimeType ?? "image/jpeg"); }
    catch (err) { return { ok: false, code: "BAD_REQUEST", message: (err as Error).message }; }
  }
  const sweep = await import("./cashSweep");
  const d = await sweep.database();
  const res: any = await d.execute(sql`INSERT INTO cash_mb_receipts (parkId, projectId, day, amount, bookingId, photoKey, photoUrl, note, uploadedBy, uploadedAt)
    VALUES (${o.parkId}, ${scope.projectId}, ${o.day}, ${o.amount}, ${o.bookingId ?? null}, ${file?.key ?? null}, ${file?.url ?? null}, ${o.note ?? null}, ${o.userId}, ${utc(Date.now())})`);
  const id = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
  await evaluateMbDay(d, { parkId: o.parkId, day: o.day, projectId: scope.projectId, parkName: scope.parkName, userId: o.userId, confirm: false }).catch(() => null);
  return { ok: true, id };
}

/** Tirar um talão (fica registado quem e quando; a foto fica guardada). */
export async function removeMbReceipt(o: { id: number; userId: number }): Promise<{ ok: true } | Fail> {
  const sweep = await import("./cashSweep");
  const d = await sweep.database();
  const r = rowsOf(await d.execute(sql`SELECT parkId, DATE_FORMAT(day, '%Y-%m-%d') AS day FROM cash_mb_receipts WHERE id = ${o.id} AND removedAt IS NULL LIMIT 1`))[0];
  if (!r) return { ok: false, code: "NOT_FOUND", message: "Talão não encontrado." };
  const { parkInScope } = await import("./cashCheck/caseQueries");
  const scope = await parkInScope(String(r.parkId));
  if (!scope.ok) return { ok: false, code: "FORBIDDEN", message: scope.message };
  await d.execute(sql`UPDATE cash_mb_receipts SET removedAt = ${utc(Date.now())}, removedBy = ${o.userId} WHERE id = ${o.id}`);
  await evaluateMbDay(d, { parkId: String(r.parkId), day: String(r.day), projectId: scope.projectId, parkName: scope.parkName, userId: o.userId, confirm: false }).catch(() => null);
  return { ok: true };
}

/** "Confirmar multibanco do dia": regista quem confirmou e abre/resolve o caso. */
export async function confirmMbDay(o: { parkId: string; day: string; userId: number }): Promise<{ ok: true; unmatched: number; extra: number; caseOpened: boolean } | Fail> {
  const { parkInScope } = await import("./cashCheck/caseQueries");
  const scope = await parkInScope(o.parkId);
  if (!scope.ok) return { ok: false, code: "FORBIDDEN", message: scope.message };
  const sweep = await import("./cashSweep");
  const d = await sweep.database();
  try {
    const r = await evaluateMbDay(d, { parkId: o.parkId, day: o.day, projectId: scope.projectId, parkName: scope.parkName, userId: o.userId, confirm: true });
    return { ok: true, ...r };
  } catch {
    return { ok: false, code: "INTERNAL_SERVER_ERROR", message: "BD da Multipark sem resposta: tenta daqui a pouco." };
  }
}

// ─── Viva Wallet (CSV exportado) ───────────────────────────────────────────

export async function importVivaCsv(o: { csv: string; fileName?: string | null; userId: number }):
  Promise<{ ok: true; importId: number; txns: number; matched: number; missing: number; extra: number; casesOpened: number; errors: string[] } | Fail> {
  const parsed = parseVivaCsv(o.csv);
  const terminal = parsed.txns.filter((t) => t.channel !== "link");
  if (!terminal.length) return { ok: false, code: "BAD_REQUEST", message: parsed.errors[0] ?? "Sem transações do terminal no ficheiro." };
  const [sweep, live, { planCaseActions }, { lisbonDayRangeUtc }, { loadLiveContext }] = await Promise.all([
    import("./cashSweep"), import("./multiparkDb/cashExternal"), import("./cashCheck/cases"), import("../shared/lisbonDay"), import("./finance/liveBookings"),
  ]);
  const txDays = [...new Set(terminal.map((t) => lisbonDayOf(t.at)).filter((x): x is string => !!x))].sort();
  // Os pagamentos do último dia podem estar no dia seguinte do terminal: só se avaliam os dias com o dia seguinte no ficheiro, exceto se for o único.
  const days = txDays.length > 1 ? txDays.slice(0, -1) : txDays;
  const ctx = await loadLiveContext();
  const parkIds = [...ctx.ourParks.keys()];
  const range = lisbonDayRangeUtc(days[0], days[days.length - 1]);
  let pays: RecordedPayment[];
  try { pays = await live.readPaymentsInWindow({ parkIds, start: range.start, end: range.end }); }
  catch { return { ok: false, code: "INTERNAL_SERVER_ERROR", message: "BD da Multipark sem resposta: tenta daqui a pouco." }; }
  const m = matchViva({ payments: pays, txns: terminal, days });
  const d = await sweep.database();
  const nowDb = utc(Date.now());
  const subjects = new Map<string, { code: string | null; parkId: string | null }>();
  for (const p of pays) if (p.amount > 0) subjects.set(p.bookingId, { code: p.code, parkId: p.parkId });
  const existing = await sweep.loadCases(d, "booking", [...subjects.keys()]);
  let casesOpened = 0;
  for (const [id, v] of subjects) {
    const miss = m.missing.get(id);
    const ex = existing.get(id) ?? [];
    if (!miss && !ex.some((c) => c.code === "mb_unconfirmed")) continue;
    const r = await sweep.applyActions(d, { subjectType: "booking", subjectId: id, parkId: v.parkId, projectId: v.parkId ? ctx.ourParks.get(v.parkId) ?? null : null, bookingCode: v.code, day: null },
      planCaseActions(ex, miss ? [vivaMissingFinding(miss.items)] : [], new Set(["mb_unconfirmed"])), nowDb);
    casesOpened += r.opened + r.reopened;
  }
  await sweep.flushCaseAlerts(d, nowDb);
  const res: any = await d.execute(sql`INSERT INTO cash_viva_imports (fileName, periodStart, periodEnd, txnCount, matchedCount, casesOpened, summaryJson, uploadedBy, uploadedAt)
    VALUES (${o.fileName ?? null}, ${days[0]}, ${days[days.length - 1]}, ${terminal.length}, ${m.matched.length}, ${casesOpened},
      ${JSON.stringify({ missing: m.missing.size, extra: m.extra.length, links: parsed.txns.length - terminal.length, errors: parsed.errors.length })}, ${o.userId}, ${nowDb})`);
  const importId = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
  const matchedTx = new Map(m.matched.map((x) => [x.txnId, x.bookingId]));
  const extra = new Set(m.extra.map((t) => t.id));
  for (let i = 0; i < terminal.length; i += 200) {
    const chunk = terminal.slice(i, i + 200);
    await d.execute(sql`INSERT INTO cash_viva_txns (importId, txnId, at, amount, channel, terminalId, matchState, bookingId) VALUES ${sql.join(chunk.map((t) =>
      sql`(${importId}, ${t.id.slice(0, 128)}, ${t.at ? utc(Date.parse(t.at)) : null}, ${t.amount}, ${t.channel}, ${t.terminalId?.slice(0, 64) ?? null},
        ${matchedTx.has(t.id) ? "bate" : extra.has(t.id) ? "sem_reserva" : "fora_do_periodo"}, ${matchedTx.get(t.id) ?? null})`), sql`, `)}`);
  }
  return { ok: true, importId, txns: terminal.length, matched: m.matched.length, missing: m.missing.size, extra: m.extra.length, casesOpened, errors: parsed.errors };
}

export async function listVivaImports(limit = 20) {
  const sweep = await import("./cashSweep");
  const d = await sweep.database();
  const rows = rowsOf(await d.execute(sql`SELECT v.id, v.fileName, DATE_FORMAT(v.periodStart, '%Y-%m-%d') AS ps, DATE_FORMAT(v.periodEnd, '%Y-%m-%d') AS pe, v.txnCount, v.matchedCount, v.casesOpened,
      v.summaryJson, DATE_FORMAT(v.uploadedAt, '%Y-%m-%d %H:%i:%s') AS at, u.name AS byName
    FROM cash_viva_imports v LEFT JOIN users u ON u.id = v.uploadedBy ORDER BY v.uploadedAt DESC, v.id DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`));
  return rows.map((r) => {
    let s: any = null; try { s = JSON.parse(String(r.summaryJson)); } catch { s = null; }
    return { id: Number(r.id), fileName: r.fileName ?? null, periodStart: r.ps ?? null, periodEnd: r.pe ?? null, txns: Number(r.txnCount), matched: Number(r.matchedCount), casesOpened: Number(r.casesOpened), extra: Number(s?.extra ?? 0), at: String(r.at), byName: r.byName ?? null };
  });
}

// ─── Recebimentos mensais (Pro, agentes, agregadores) ──────────────────────

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function monthRangeDays(month: string): { first: string; last: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, "0")}` };
}

/** Devido no mês (Multipark ao vivo) e o recebido registado, por entidade. */
export async function monthlyOverview(month: string) {
  if (!MONTH_RE.test(month)) return { available: false as const, reason: "Mês inválido." };
  const [sweep, live, { lisbonDayRangeUtc }, { loadLiveContext }] = await Promise.all([import("./cashSweep"), import("./multiparkDb/cashExternal"), import("../shared/lisbonDay"), import("./finance/liveBookings")]);
  const d = await sweep.database();
  const ctx = await loadLiveContext();
  const { first, last } = monthRangeDays(month);
  const range = lisbonDayRangeUtc(first, last);
  let dues: Awaited<ReturnType<typeof live.readMonthDues>> = [];
  let duesError: string | null = null;
  try { dues = await live.readMonthDues({ parkIds: [...ctx.ourParks.keys()], start: range.start, end: range.end }); }
  catch { duesError = "BD da Multipark sem resposta: não dá para calcular o devido do mês."; }
  const receipts = rowsOf(await d.execute(sql`SELECT r.id, r.kind, r.entityId, r.entityName, r.amount, DATE_FORMAT(r.receivedOn, '%Y-%m-%d') AS receivedOn, r.proofKey, r.proofUrl, r.note,
      DATE_FORMAT(r.createdAt, '%Y-%m-%d %H:%i:%s') AS at, u.name AS byName
    FROM cash_monthly_receipts r LEFT JOIN users u ON u.id = r.createdBy WHERE r.month = ${month} AND r.removedAt IS NULL ORDER BY r.id LIMIT 2000`));
  const key = (kind: string, id: string) => `${kind}|${id}`;
  const rows = new Map<string, { kind: MonthlyKind; entityId: string; name: string; bookings: number; due: number | null; received: number; receipts: any[] }>();
  for (const x of dues) {
    const kind: MonthlyKind = x.kind === "pro" ? "pro" : monthlyKindOf(x.partnerType);
    rows.set(key(kind, x.entityId), { kind, entityId: x.entityId, name: x.name ?? x.entityId, bookings: x.bookings, due: x.due, received: 0, receipts: [] });
  }
  for (const r of receipts) {
    const k = key(String(r.kind), String(r.entityId));
    const row = rows.get(k) ?? { kind: String(r.kind) as MonthlyKind, entityId: String(r.entityId), name: r.entityName ?? String(r.entityId), bookings: 0, due: null, received: 0, receipts: [] as any[] };
    row.received = r2(row.received + Number(r.amount));
    row.receipts.push({ id: Number(r.id), amount: Number(r.amount), receivedOn: r.receivedOn ?? null, note: r.note ?? null, at: String(r.at), byName: r.byName ?? null, proofUrl: await fileUrl(r.proofKey ?? null, r.proofUrl ?? null) });
    rows.set(k, row);
  }
  const list = [...rows.values()].map((x) => ({ ...x, difference: x.due == null ? null : r2(x.received - x.due) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || (b.due ?? 0) - (a.due ?? 0));
  return { available: true as const, month, duesError, rows: list };
}

async function evaluateMonthly(d: Db, o: { kind: MonthlyKind; entityId: string; name: string; month: string }) {
  const overview = await monthlyOverview(o.month);
  if (!overview.available || overview.duesError) return false;
  const row = overview.rows.find((x) => x.kind === o.kind && x.entityId === o.entityId);
  const f = row ? monthlyReceiptFinding({ kind: o.kind, name: row.name, month: o.month, received: row.received, due: row.due }) : null;
  const [sweep, { planCaseActions }] = await Promise.all([import("./cashSweep"), import("./cashCheck/cases")]);
  const subjectId = `${o.kind}:${o.entityId}:${o.month}`.slice(0, 191);
  const existing = (await sweep.loadCases(d, "mensal", [subjectId])).get(subjectId) ?? [];
  const nowDb = utc(Date.now());
  const r = await sweep.applyActions(d, { subjectType: "mensal", subjectId, parkId: null, projectId: null, bookingCode: null, day: `${o.month}-01` },
    planCaseActions(existing, f ? [f] : [], new Set(["monthly_receipt"])), nowDb);
  return r.opened + r.reopened > 0;
}

export async function addMonthlyReceipt(o: { kind: MonthlyKind; entityId: string; entityName: string; month: string; amount: number; receivedOn?: string | null; note?: string | null; proofBase64?: string | null; mimeType?: string | null; userId: number }):
  Promise<{ ok: true; id: number; caseOpened: boolean } | Fail> {
  if (!MONTH_RE.test(o.month)) return { ok: false, code: "BAD_REQUEST", message: "Mês inválido." };
  let file: { key: string; url: string } | null = null;
  if (o.proofBase64) {
    try { file = await storeFile(`cash/mensal/${o.month}/${o.kind}`, o.proofBase64, o.mimeType ?? "application/pdf"); }
    catch (err) { return { ok: false, code: "BAD_REQUEST", message: (err as Error).message }; }
  }
  const sweep = await import("./cashSweep");
  const d = await sweep.database();
  const res: any = await d.execute(sql`INSERT INTO cash_monthly_receipts (kind, entityId, entityName, month, amount, receivedOn, proofKey, proofUrl, note, createdBy, createdAt)
    VALUES (${o.kind}, ${o.entityId.slice(0, 191)}, ${o.entityName.slice(0, 255)}, ${o.month}, ${o.amount}, ${o.receivedOn ?? null}, ${file?.key ?? null}, ${file?.url ?? null}, ${o.note ?? null}, ${o.userId}, ${utc(Date.now())})`);
  const id = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
  const caseOpened = await evaluateMonthly(d, { kind: o.kind, entityId: o.entityId, name: o.entityName, month: o.month }).catch(() => false);
  return { ok: true, id, caseOpened };
}

export async function removeMonthlyReceipt(o: { id: number; userId: number }): Promise<{ ok: true } | Fail> {
  const sweep = await import("./cashSweep");
  const d = await sweep.database();
  const r = rowsOf(await d.execute(sql`SELECT kind, entityId, entityName, month FROM cash_monthly_receipts WHERE id = ${o.id} AND removedAt IS NULL LIMIT 1`))[0];
  if (!r) return { ok: false, code: "NOT_FOUND", message: "Recebimento não encontrado." };
  await d.execute(sql`UPDATE cash_monthly_receipts SET removedAt = ${utc(Date.now())}, removedBy = ${o.userId} WHERE id = ${o.id}`);
  await evaluateMonthly(d, { kind: String(r.kind) as MonthlyKind, entityId: String(r.entityId), name: String(r.entityName ?? r.entityId), month: String(r.month) }).catch(() => false);
  return { ok: true };
}

export { MONTHLY_LABEL };
