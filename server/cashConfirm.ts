/**
 * Confirmação da caixa reserva a reserva — servidor (plano
 * docs/plans/2026-10-13-confirmacao-caixa-plano.md; decisões do Jorge de 13 out 2026).
 *
 * Fluxo: os condutores entregam ao team leader, que fecha na Multipark e
 * declara na Passagem de turno o dinheiro e o MB recebidos e o total que dava a
 * caixa. No dia seguinte o João abre Caixa → Confirmação (cidade × dia):
 *  - vê cada reserva lado a lado (preço quando nasceu, original, final, pago por
 *    método, crédito/taxa, as 3 validações da Multipark) com os achados;
 *  - anexa os talões MB, justifica os vermelhos (motivo + explicação +
 *    comprovativo) e confirma os valores do envelope e do MB;
 *  - fecha o dia. Diferença > 30 € ou justificações por aprovar → "à espera do
 *    Jorge" (amarelo no mês) + aviso na app; > 70 € → também email.
 * O Jorge aprova ou recusa (recusar reabre o dia). Uma varredura diária relê os
 * dias fechados: se a Multipark mudou uma reserva selada, o dia reabre.
 *
 * Nunca escreve na Multipark. Na nossa BD: `cash_confirm_days` (estado, a única
 * mutável) e tabelas SÓ ACRÉSCIMO (eventos em cadeia de hashes, justificações,
 * decisões, ficheiros, retiradas de ficheiros) — um teste garante que não há
 * UPDATE/DELETE nelas. Falha fechado: sem Multipark, com dados cortados ou sem
 * Stripe, nada fica verde e o dia não fecha.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bookingFindings, buildBookingView, bookingMoneyState, validationFlags, canonicalJson, closeBlockers, daySummary, justificationProblem, statusAfterClose,
  toCents, eur, ORIGIN_LATE_MS, FINDING_LABEL, type BookingView, type ConfirmOrigin, type DayStatus, type DaySummary, type Finding,
  type JustificationRef, type MbReceiptRef, type ShiftDeclaration, type StripeCheck,
} from "../shared/cashConfirm";
import type { HandoverCity } from "./shiftExpenses";

export const CONFIRM_CITIES: readonly HandoverCity[] = ["lisbon", "porto", "faro"];
export const GENESIS_HASH = "0".repeat(64);
export const STRIPE_CONFIRM_MAX = 300;
const STRIPE_CONCURRENCY = 6;
const STRIPE_CACHE_MS = 10 * 60_000;
/** Quantos dias para trás a varredura relê os dias fechados. */
export const RECHECK_DAYS = 45;

type Db = { execute: (q: any) => Promise<unknown>; transaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T> };
type Fail = { ok: false; code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "INTERNAL_SERVER_ERROR"; message: string };

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const DT = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s.%f')`);
/** Agora em UTC com milissegundos ("YYYY-MM-DD HH:MM:SS.mmm"), o que se grava e entra no hash. */
export const utcStamp = (ms: number = Date.now()) => new Date(ms).toISOString().slice(0, 23).replace("T", " ");

async function db(): Promise<Db> {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw Object.assign(new Error("Base de dados indisponível"), { code: "DATABASE_UNAVAILABLE" });
  return d as unknown as Db;
}

// ─── Cadeia de eventos (só acréscimo) ───────────────────────────────────────

export interface ChainEvent { day: string; city: string; at: string; userId: number | null; action: string; findingKey: string | null; data: unknown }

/** hash = sha256(prevHash + "\n" + JSON canónico do evento). PURA. */
export function eventHash(prevHash: string, e: ChainEvent): string {
  return createHash("sha256").update(`${prevHash}\n${canonicalJson({ day: e.day, city: e.city, at: e.at, userId: e.userId, action: e.action, findingKey: e.findingKey, data: e.data ?? null })}`, "utf8").digest("hex");
}

/** Confere a cadeia de um dia (linhas por ordem de id). PURA. */
export function verifyChain(rows: ReadonlyArray<{ id: number; prevHash: string; hash: string } & ChainEvent>): { ok: boolean; brokenAt: number | null } {
  let prev = GENESIS_HASH;
  for (const r of rows) {
    if (r.prevHash !== prev || eventHash(prev, r) !== r.hash) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, brokenAt: null };
}

/** Linha da cidade × dia trancada (cria-a se faltar). Dentro de uma transação. */
async function lockDay(tx: Db, day: string, city: string): Promise<any> {
  await tx.execute(sql`INSERT IGNORE INTO cash_confirm_days (day, city, status) VALUES (${day}, ${city}, 'aberto')`);
  const [row] = rowsOf(await tx.execute(sql`SELECT * FROM cash_confirm_days WHERE day = ${day} AND city = ${city} FOR UPDATE`));
  return row;
}

/** Acrescenta um evento à cadeia do dia (chamar com o dia trancado). */
async function appendEvent(tx: Db, e: Omit<ChainEvent, "at"> & { at?: string }): Promise<string> {
  const at = e.at ?? utcStamp();
  const [last] = rowsOf(await tx.execute(sql`SELECT hash FROM cash_confirm_events WHERE day = ${e.day} AND city = ${e.city} ORDER BY id DESC LIMIT 1`));
  const prev = last?.hash ? String(last.hash) : GENESIS_HASH;
  const ev: ChainEvent = { day: e.day, city: e.city, at, userId: e.userId, action: e.action, findingKey: e.findingKey, data: e.data ?? null };
  const hash = eventHash(prev, ev);
  await tx.execute(sql`INSERT INTO cash_confirm_events (day, city, at, userId, action, findingKey, data, prevHash, hash)
    VALUES (${ev.day}, ${ev.city}, ${at}, ${ev.userId}, ${ev.action}, ${ev.findingKey}, ${canonicalJson(ev.data)}, ${prev}, ${hash})`);
  return hash;
}

async function inTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  const d = await db();
  if (!d.transaction) throw new Error("Transações indisponíveis");
  return d.transaction(fn as any);
}

// ─── Leituras da nossa BD ───────────────────────────────────────────────────

/** 1.º webhook BOOKING_CREATED de cada reserva (a origem independente do preço). */
async function originsOf(d: Db, bookingIds: readonly string[]): Promise<Map<string, ConfirmOrigin>> {
  const out = new Map<string, ConfirmOrigin>();
  const ids = [...new Set(bookingIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = rowsOf(await d.execute(sql`SELECT s.bookingId, s.bookingPrice, s.originalBookingPrice, ${DT("s.checkOut")} AS checkOut,
        ${DT("s.receivedAt")} AS receivedAt, ${DT("s.dbReadAt")} AS dbReadAt, ${DT("s.eventCreatedAt")} AS eventCreatedAt
      FROM multipark_webhook_snapshots s
      JOIN (SELECT bookingId, MIN(id) AS id FROM multipark_webhook_snapshots
             WHERE eventType = 'BOOKING_CREATED' AND bookingId IN (${sql.join(chunk.map((x) => sql`${x}`), sql`, `)}) GROUP BY bookingId) f ON f.id = s.id`));
    for (const r of rows) {
      const iso = (v: unknown) => (v ? `${String(v).replace(" ", "T")}Z` : null);
      const born = iso(r.eventCreatedAt);
      const read = iso(r.dbReadAt) ?? iso(r.receivedAt);
      const late = !!born && !!read && Date.parse(read) - Date.parse(born) > ORIGIN_LATE_MS;
      out.set(String(r.bookingId), {
        source: "webhook",
        bookingPrice: r.bookingPrice == null ? null : Number(r.bookingPrice),
        originalBookingPrice: r.originalBookingPrice == null ? null : Number(r.originalBookingPrice),
        checkOut: iso(r.checkOut), receivedAt: iso(r.receivedAt), late,
      });
    }
  }
  return out;
}

async function shiftDeclarations(d: Db, day: string, city: string): Promise<ShiftDeclaration[]> {
  const rows = rowsOf(await d.execute(sql`SELECT shift, cashierCashReceived, cashierMbReceived, cashierMultiparkTotal, filledByName
    FROM shift_handovers WHERE handoverDate = ${day} AND city = ${city}`));
  const n = (v: unknown) => (v == null ? null : Number(v));
  return rows.filter((r) => r.shift === "morning" || r.shift === "night").map((r) => ({
    shift: r.shift, cash: n(r.cashierCashReceived), mb: n(r.cashierMbReceived), multiparkTotal: n(r.cashierMultiparkTotal), byName: r.filledByName ?? null,
  }));
}

export interface DayFile { id: number; bookingId: string | null; kind: string; amountCents: number | null; mime: string; size: number; sha256: string; uploadedAt: string; byName: string | null }

async function activeFiles(d: Db, day: string, city: string): Promise<DayFile[]> {
  const rows = rowsOf(await d.execute(sql`SELECT f.id, f.bookingId, f.kind, f.amountCents, f.mime, f.size, f.sha256, ${DT("f.uploadedAt")} AS uploadedAt, u.name AS byName
    FROM cash_confirm_files f LEFT JOIN users u ON u.id = f.uploadedBy
    WHERE f.day = ${day} AND f.city = ${city} AND NOT EXISTS (SELECT 1 FROM cash_confirm_file_removals r WHERE r.fileId = f.id) ORDER BY f.id`));
  return rows.map((r) => ({
    id: Number(r.id), bookingId: r.bookingId ?? null, kind: String(r.kind), amountCents: r.amountCents == null ? null : Number(r.amountCents),
    mime: String(r.mime), size: Number(r.size), sha256: String(r.sha256), uploadedAt: String(r.uploadedAt), byName: r.byName ?? null,
  }));
}

export interface DayJustification extends JustificationRef { code: string; color: string; amountCents: number; byName: string | null; at: string; userId: number; decidedByName: string | null; decisionNote: string | null; fileIds: number[] }

/** Última justificação por achado + a última decisão do Jorge sobre ela. */
async function justificationsOf(d: Db, day: string, city: string): Promise<Map<string, DayJustification>> {
  const rows = rowsOf(await d.execute(sql`SELECT j.id, j.findingKey, j.code, j.color, j.amountCents, j.reason, j.explanation, j.fileIds, j.userId, ${DT("j.at")} AS at, u.name AS byName,
      (SELECT x.decision FROM cash_confirm_decisions x WHERE x.justificationId = j.id ORDER BY x.id DESC LIMIT 1) AS decision,
      (SELECT x.note FROM cash_confirm_decisions x WHERE x.justificationId = j.id ORDER BY x.id DESC LIMIT 1) AS decisionNote,
      (SELECT uu.name FROM cash_confirm_decisions x LEFT JOIN users uu ON uu.id = x.userId WHERE x.justificationId = j.id ORDER BY x.id DESC LIMIT 1) AS decidedByName
    FROM cash_confirm_justifications j LEFT JOIN users u ON u.id = j.userId
    WHERE j.day = ${day} AND j.city = ${city} ORDER BY j.id`));
  const out = new Map<string, DayJustification>();
  for (const r of rows) {
    let fileIds: number[] = [];
    try { fileIds = (JSON.parse(String(r.fileIds ?? "[]")) as unknown[]).map(Number).filter(Number.isFinite); } catch { fileIds = []; }
    out.set(String(r.findingKey), {
      id: Number(r.id), findingKey: String(r.findingKey), code: String(r.code), color: String(r.color), amountCents: Number(r.amountCents ?? 0),
      reason: String(r.reason), explanation: String(r.explanation), fileCount: fileIds.length, fileIds,
      decision: r.decision === "aprovado" || r.decision === "recusado" ? r.decision : null,
      userId: Number(r.userId), byName: r.byName ?? null, at: String(r.at), decidedByName: r.decidedByName ?? null, decisionNote: r.decisionNote ?? null,
    });
  }
  return out;
}

// ─── Stripe (com cache curto; nunca lança) ──────────────────────────────────

const stripeCache = new Map<string, { at: number; value: StripeCheck | null }>();

async function stripeChecks(ids: readonly string[]): Promise<{ available: boolean; checks: Map<string, StripeCheck | null>; reason: string | null }> {
  const [{ cashFlags }, { stripeKeyState, stripeGetPayment }] = await Promise.all([import("./cashExternal"), import("./external/stripe")]);
  const flags = await cashFlags().catch(() => ({ stripe: false }));
  if (!flags.stripe) return { available: false, checks: new Map(), reason: "A verificação da Stripe está desligada (Definições → Automações → CASH_STRIPE_CHECK)." };
  if (stripeKeyState() !== "ok") return { available: false, checks: new Map(), reason: "Falta a chave de leitura da Stripe (STRIPE_READ_KEY, restrita rk_)." };
  const out = new Map<string, StripeCheck | null>();
  const todo: string[] = [];
  const now = Date.now();
  for (const id of new Set(ids)) {
    const c = stripeCache.get(id);
    if (c && now - c.at < STRIPE_CACHE_MS) out.set(id, c.value); else todo.push(id);
  }
  // Acima do limite ficam por ler → "não verificável" (falha fechado), nunca verdes.
  const batch = todo.slice(0, STRIPE_CONFIRM_MAX);
  for (let i = 0; i < batch.length; i += STRIPE_CONCURRENCY) {
    await Promise.all(batch.slice(i, i + STRIPE_CONCURRENCY).map(async (id) => {
      const r = await stripeGetPayment(id);
      if (!r.ok) return; // sem resposta: fica por ler (não entra em `out`)
      const v: StripeCheck | null = r.payment ? { status: r.payment.status, received: r.payment.received, refunded: r.payment.refunded, disputed: r.payment.disputed } : null;
      stripeCache.set(id, { at: Date.now(), value: v });
      out.set(id, v);
    }));
  }
  if (stripeCache.size > 5000) stripeCache.clear();
  return { available: true, checks: out, reason: todo.length > STRIPE_CONFIRM_MAX ? `Há mais de ${STRIPE_CONFIRM_MAX} pagamentos online por ler: os restantes ficam por verificar.` : null };
}

// ─── O dia ──────────────────────────────────────────────────────────────────

export interface ConfirmDayData {
  available: true;
  day: string; city: HandoverCity; window: string; dayClosed: boolean;
  status: DayStatus; state: {
    confirmedCash: number | null; confirmedMb: number | null; note: string | null;
    closedByName: string | null; closedAt: string | null; approvedByName: string | null; approvedAt: string | null;
    reopenReason: string | null; sealHash: string | null;
  };
  summary: DaySummary;
  shifts: ShiftDeclaration[];
  views: BookingView[];
  counts: { bookings: number; red: number; amber: number; green: number };
  files: DayFile[];
  justifications: DayJustification[];
  blockers: string[];
  truncated: boolean;
  stripe: { available: boolean; reason: string | null };
  chain: { ok: boolean; events: number };
  events: Array<{ id: number; at: string; action: string; findingKey: string | null; byName: string | null; data: unknown }>;
  /** Estados por reserva (para o selo e para a varredura). */
  states: Record<string, string>;
}
export type ConfirmDayResult = ConfirmDayData | { available: false; reason: string };

const stateHash = (o: unknown) => createHash("sha256").update(canonicalJson(o), "utf8").digest("hex");

/** Monta o dia (lê tudo, calcula achados). Nunca lança por falta da Multipark: devolve { available:false }. */
export async function loadConfirmDay(day: string, city: HandoverCity, cities: string[] | undefined): Promise<ConfirmDayResult> {
  const [{ readConfirmDay }, { buildParksSql, mapParks }, { multiparkDbQuery }, { safeMultiparkRead }, win, { getSetting }, { shiftExpensesByCity }, { isOperatedPark, cityOfParkName }] = await Promise.all([
    import("./multiparkDb/cashConfirm"), import("./multiparkDb/dayBookings"), import("./multiparkDb/client"), import("./multiparkDb/read"),
    import("../shared/cashDayWindow"), import("./appSettings"), import("./shiftExpenses"), import("./cashDay"),
  ]);
  const excluded: string[] = ((await getSetting("operations.excludedParks")) as string[] | null) ?? [];
  const range = win.cashDayRangeUtc(day);
  const r = await safeMultiparkRead("confirmação da caixa", async () => {
    const parks = mapParks(await multiparkDbQuery(buildParksSql().sql), cities)
      .filter((p) => isOperatedPark(p, excluded) && cityOfParkName(p.cityName) === city).map((p) => p.id);
    return { parks, read: await readConfirmDay({ parkIds: parks, start: range.start, end: range.end }) };
  });
  if (!r.available) return { available: false, reason: r.reason };
  const d = await db();
  const rows = r.data.read.rows;
  const partners = new Set(r.data.read.partnerNames.map((x) => x.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim()));
  const [origins, shifts, files, justs, dayRows, expenses, evRows] = await Promise.all([
    originsOf(d, rows.map((x) => x.live.id)),
    shiftDeclarations(d, day, city),
    activeFiles(d, day, city),
    justificationsOf(d, day, city),
    d.execute(sql`SELECT c.*, ${DT("c.closedAt")} AS closedAtS, ${DT("c.approvedAt")} AS approvedAtS, uc.name AS closedByName, ua.name AS approvedByName
      FROM cash_confirm_days c LEFT JOIN users uc ON uc.id = c.closedBy LEFT JOIN users ua ON ua.id = c.approvedBy WHERE c.day = ${day} AND c.city = ${city}`).then(rowsOf),
    shiftExpensesByCity(day),
    d.execute(sql`SELECT e.id, e.day, e.city, ${DT("e.at")} AS at, e.userId, e.action, e.findingKey, e.data, e.prevHash, e.hash, u.name AS byName
      FROM cash_confirm_events e LEFT JOIN users u ON u.id = e.userId WHERE e.day = ${day} AND e.city = ${city} ORDER BY e.id`).then(rowsOf),
  ]);
  const st = dayRows[0] ?? null;

  const onlineIntents = rows.flatMap((x) => x.live.payments.some((p) => /online|stripe|mb ?way/i.test(p.method ?? "")) ? x.live.intents.map((i) => i.id) : []);
  const stripe = await stripeChecks(onlineIntents);
  const receipts: MbReceiptRef[] = files.filter((f) => f.kind === "talao_mb" && f.amountCents != null).map((f) => ({ id: f.id, amountCents: f.amountCents as number, bookingId: f.bookingId }));
  const inWindow = (iso: string | null) => !!iso && Date.parse(iso) >= range.startMs && Date.parse(iso) < range.endMs;

  const views: BookingView[] = [];
  const states: Record<string, string> = {};
  const windowPayments: Array<{ amount: number | null; method: string | null }> = [];
  for (const row of rows) {
    const live = row.live;
    const windowIds = new Set(live.payments.filter((p) => inWindow(p.recordedAt)).map((p) => p.id));
    for (const p of live.payments) if (windowIds.has(p.id)) windowPayments.push({ amount: p.amount, method: p.method });
    const findings: Finding[] = bookingFindings({
      live, origin: origins.get(live.id) ?? null, windowPaymentIds: windowIds, inDay: row.kind,
      stripe: stripe.checks, stripeAvailable: stripe.available, mbReceipts: receipts, partnerNames: partners,
    });
    views.push(buildBookingView({ live, origin: origins.get(live.id) ?? null, inDay: row.kind, findings, justifications: justs, partnerNames: partners }));
    states[live.id] = `${stateHash(bookingMoneyState(live, partners))}|${validationFlags(live)}`;
  }
  const RANK = { red: 0, amber: 1, green: 2 } as const;
  views.sort((a, b) => RANK[a.color] - RANK[b.color] || (b.findings.length - a.findings.length) || String(a.checkOut ?? "").localeCompare(String(b.checkOut ?? "")));
  const confirmed = st ? { cash: st.confirmedCash == null ? null : Number(st.confirmedCash), mb: st.confirmedMb == null ? null : Number(st.confirmedMb) } : null;
  const se = expenses.get(city) ?? { total: 0, count: 0 };
  const summary = daySummary({ windowPayments, shiftExpenses: se.total, shifts, confirmed, partnerNames: partners });
  const status: DayStatus = (st?.status as DayStatus) ?? "aberto";
  const truncated = r.data.read.truncated;
  const blockers = status === "aberto" || status === "reaberto"
    ? closeBlockers({ dayClosedAt3am: win.isCashDayClosed(day), truncated, multiparkOk: true, views, summary, noteLen: String(st?.note ?? "").trim().length })
    : [];
  const chain = verifyChain(evRows.map((e) => ({ id: Number(e.id), day: String(e.day), city: String(e.city), at: String(e.at).slice(0, 23), userId: e.userId == null ? null : Number(e.userId), action: String(e.action), findingKey: e.findingKey ?? null, data: parseJson(e.data), prevHash: String(e.prevHash), hash: String(e.hash) })));
  return {
    available: true, day, city, window: win.cashDayWindowLabel(day), dayClosed: win.isCashDayClosed(day),
    status,
    state: {
      confirmedCash: confirmed?.cash ?? null, confirmedMb: confirmed?.mb ?? null, note: st?.note ?? null,
      closedByName: st?.closedByName ?? null, closedAt: st?.closedAtS ?? null, approvedByName: st?.approvedByName ?? null, approvedAt: st?.approvedAtS ?? null,
      reopenReason: st?.reopenReason ?? null, sealHash: st?.sealHash ?? null,
    },
    summary, shifts, views,
    counts: { bookings: views.length, red: views.filter((v) => v.color === "red").length, amber: views.filter((v) => v.color === "amber").length, green: views.filter((v) => v.color === "green").length },
    files, justifications: [...justs.values()], blockers, truncated,
    stripe: { available: stripe.available, reason: stripe.reason },
    chain: { ok: chain.ok, events: evRows.length },
    events: evRows.slice(-80).reverse().map((e) => ({ id: Number(e.id), at: String(e.at).slice(0, 19), action: String(e.action), findingKey: e.findingKey ?? null, byName: e.byName ?? null, data: parseJson(e.data) })),
    states,
  };
}

function parseJson(v: unknown): unknown {
  if (v == null) return null;
  try { return JSON.parse(String(v)); } catch { return String(v); }
}

const isOpen = (s: string | null | undefined) => !s || s === "aberto" || s === "reaberto";

// ─── Escritas ───────────────────────────────────────────────────────────────

/** Justificar um achado (o João). O servidor relê o dia: o achado tem de existir agora. */
export async function justifyFinding(o: { day: string; city: HandoverCity; cities: string[] | undefined; findingKey: string; reason: string; explanation: string; fileIds: number[]; userId: number }): Promise<{ ok: true } | Fail> {
  const data = await loadConfirmDay(o.day, o.city, o.cities);
  if (!data.available) return { ok: false, code: "INTERNAL_SERVER_ERROR", message: `BD da Multipark sem resposta: ${data.reason}` };
  if (!isOpen(data.status)) return { ok: false, code: "CONFLICT", message: "O dia já está fechado: só o Jorge o pode reabrir." };
  const f = data.views.flatMap((v) => v.findings).find((x) => x.key === o.findingKey);
  if (!f) return { ok: false, code: "NOT_FOUND", message: "Este achado já não existe (a Multipark mudou?). Atualiza a página." };
  if (f.color === "green") return { ok: false, code: "BAD_REQUEST", message: "Não há nada a justificar." };
  const fileIds = [...new Set(o.fileIds)];
  const valid = new Set(data.files.filter((x) => x.kind === "comprovativo" && (x.bookingId == null || x.bookingId === f.bookingId)).map((x) => x.id));
  if (fileIds.some((id) => !valid.has(id))) return { ok: false, code: "BAD_REQUEST", message: "Um dos comprovativos não é deste dia/reserva ou foi retirado." };
  const problem = justificationProblem({ finding: f, reason: o.reason, explanation: o.explanation, fileCount: fileIds.length });
  if (problem) return { ok: false, code: "BAD_REQUEST", message: problem };
  await inTx(async (tx) => {
    const day = await lockDay(tx, o.day, o.city);
    if (!isOpen(day?.status)) throw Object.assign(new Error("O dia já está fechado."), { code: "CONFLICT" });
    const at = utcStamp();
    await tx.execute(sql`INSERT INTO cash_confirm_justifications (day, city, findingKey, bookingId, code, color, amountCents, reason, explanation, fileIds, userId, at)
      VALUES (${o.day}, ${o.city}, ${f.key}, ${f.bookingId}, ${f.code}, ${f.color}, ${f.amountCents}, ${o.reason}, ${o.explanation.trim()}, ${JSON.stringify(fileIds)}, ${o.userId}, ${at})`);
    await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: "justificar", findingKey: f.key, data: { code: f.code, color: f.color, amountCents: f.amountCents, reason: o.reason, explanation: o.explanation.trim(), fileIds } });
  });
  return { ok: true };
}

export const FILE_MAX_BYTES = 3_300_000; // abaixo do limite de pedido da Vercel (o cliente comprime as fotos)
const FILE_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;

/** Anexar um talão MB (com valor) ou um comprovativo. O mesmo ficheiro (sha256) nunca serve duas vezes. */
export async function uploadConfirmFile(o: { day: string; city: HandoverCity; bookingId: string | null; kind: "talao_mb" | "comprovativo"; amount: number | null; base64: string; mimeType: string; userId: number }): Promise<{ ok: true; id: number } | Fail> {
  if (!FILE_MIME.test(o.mimeType)) return { ok: false, code: "BAD_REQUEST", message: "Só fotos (JPG, PNG, WebP, HEIC) ou PDF." };
  const buf = Buffer.from(o.base64, "base64");
  if (!buf.length || buf.length > FILE_MAX_BYTES) return { ok: false, code: "BAD_REQUEST", message: "Ficheiro vazio ou maior do que 3,3 MB (a foto é reduzida antes de enviar; tenta outra vez)." };
  if (o.kind === "talao_mb" && (o.amount == null || !(o.amount > 0) || !o.bookingId)) return { ok: false, code: "BAD_REQUEST", message: "O talão precisa da reserva e do valor." };
  const sha = createHash("sha256").update(buf).digest("hex");
  const d = await db();
  const [dup] = rowsOf(await d.execute(sql`SELECT id, day, city, bookingId FROM cash_confirm_files WHERE sha256 = ${sha} LIMIT 1`));
  if (dup) return { ok: false, code: "CONFLICT", message: `Este ficheiro já foi anexado (${dup.day}${dup.bookingId ? `, reserva ${dup.bookingId}` : ""}). O mesmo talão não pode servir duas vezes.` };
  const { storagePut } = await import("./storage");
  const ext = o.mimeType === "application/pdf" ? "pdf" : o.mimeType.split("/")[1] ?? "jpg";
  const key = `cash/confirm/${o.city}/${o.day}/${o.kind}-${Date.now()}-${sha.slice(0, 12)}.${ext}`;
  await storagePut(key, buf, o.mimeType);
  let id = 0;
  try {
    await inTx(async (tx) => {
      const day = await lockDay(tx, o.day, o.city);
      if (!isOpen(day?.status)) throw Object.assign(new Error("O dia já está fechado."), { code: "CONFLICT" });
      const at = utcStamp();
      const amountCents = o.amount == null ? null : toCents(o.amount);
      await tx.execute(sql`INSERT INTO cash_confirm_files (day, city, bookingId, kind, amountCents, storageKey, mime, size, sha256, uploadedBy, uploadedAt)
        VALUES (${o.day}, ${o.city}, ${o.bookingId}, ${o.kind}, ${amountCents}, ${key}, ${o.mimeType}, ${buf.length}, ${sha}, ${o.userId}, ${at})`);
      const [row] = rowsOf(await tx.execute(sql`SELECT id FROM cash_confirm_files WHERE sha256 = ${sha} LIMIT 1`));
      id = Number(row?.id ?? 0);
      await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: o.kind === "talao_mb" ? "anexar_talao" : "anexar_comprovativo", findingKey: null, data: { fileId: id, bookingId: o.bookingId, amountCents, sha256: sha, size: buf.length } });
    });
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) return { ok: false, code: "CONFLICT", message: "Este ficheiro já foi anexado." };
    if (err?.code === "CONFLICT") return { ok: false, code: "CONFLICT", message: err.message };
    throw err;
  }
  return { ok: true, id };
}

/** Retirar um ficheiro (fica guardado; só deixa de contar). Só com o dia aberto. */
export async function removeConfirmFile(o: { day: string; city: HandoverCity; fileId: number; reason: string; userId: number }): Promise<{ ok: true } | Fail> {
  const reason = o.reason.trim();
  if (reason.length < 5) return { ok: false, code: "BAD_REQUEST", message: "Diz porque retiras o ficheiro (pelo menos 5 carateres)." };
  return inTx(async (tx) => {
    const day = await lockDay(tx, o.day, o.city);
    if (!isOpen(day?.status)) return { ok: false as const, code: "CONFLICT" as const, message: "O dia já está fechado." };
    const [f] = rowsOf(await tx.execute(sql`SELECT id FROM cash_confirm_files WHERE id = ${o.fileId} AND day = ${o.day} AND city = ${o.city} LIMIT 1`));
    if (!f) return { ok: false as const, code: "NOT_FOUND" as const, message: "Ficheiro não encontrado neste dia." };
    const [gone] = rowsOf(await tx.execute(sql`SELECT fileId FROM cash_confirm_file_removals WHERE fileId = ${o.fileId}`));
    if (gone) return { ok: true as const };
    const at = utcStamp();
    await tx.execute(sql`INSERT INTO cash_confirm_file_removals (fileId, userId, reason, at) VALUES (${o.fileId}, ${o.userId}, ${reason.slice(0, 255)}, ${at})`);
    await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: "retirar_ficheiro", findingKey: null, data: { fileId: o.fileId, reason: reason.slice(0, 255) } });
    return { ok: true as const };
  });
}

/** O João confirma o dinheiro do envelope, o MB e a nota do dia (só com o dia aberto). */
export async function saveConfirmValues(o: { day: string; city: HandoverCity; cash: number | null; mb: number | null; note: string | null; userId: number }): Promise<{ ok: true } | Fail> {
  return inTx(async (tx) => {
    const day = await lockDay(tx, o.day, o.city);
    if (!isOpen(day?.status)) return { ok: false as const, code: "CONFLICT" as const, message: "O dia já está fechado." };
    const note = (o.note ?? "").trim() || null;
    await tx.execute(sql`UPDATE cash_confirm_days SET confirmedCash = ${o.cash}, confirmedMb = ${o.mb}, note = ${note} WHERE day = ${o.day} AND city = ${o.city}`);
    await appendEvent(tx, { day: o.day, city: o.city, userId: o.userId, action: "confirmar_valores", findingKey: null, data: { cash: o.cash, mb: o.mb, note } });
    return { ok: true as const };
  });
}

/** Selo do dia: totais + estado de cada reserva (hash) + cabeça da cadeia. PURA. */
export function buildSeal(o: { day: string; city: string; summary: DaySummary; states: Record<string, string>; justificationIds: number[]; fileIds: number[]; chainHead: string; status: DayStatus }) {
  const seal = { v: 1, day: o.day, city: o.city, status: o.status, summary: o.summary, states: o.states, justificationIds: [...o.justificationIds].sort((a, b) => a - b), fileIds: [...o.fileIds].sort((a, b) => a - b), chainHead: o.chainHead };
  const json = canonicalJson(seal);
  return { json, hash: createHash("sha256").update(json, "utf8").digest("hex") };
}

/** O João fecha o dia. */
export async function closeConfirmDay(o: { day: string; city: HandoverCity; cities: string[] | undefined; userId: number; userName: string | null }): Promise<{ ok: true; status: DayStatus; alert: string } | Fail> {
  const data = await loadConfirmDay(o.day, o.city, o.cities);
  if (!data.available) return { ok: false, code: "INTERNAL_SERVER_ERROR", message: `BD da Multipark sem resposta: ${data.reason}` };
  if (!isOpen(data.status)) return { ok: false, code: "CONFLICT", message: "O dia já está fechado." };
  if (data.blockers.length) return { ok: false, code: "BAD_REQUEST", message: data.blockers.join(" ") };
  const status = statusAfterClose({ views: data.views, summary: data.summary });
  const res = await inTx(async (tx) => {
    const day = await lockDay(tx, o.day, o.city);
    if (!isOpen(day?.status)) return { ok: false as const, code: "CONFLICT" as const, message: "O dia já está fechado." };
    // Os valores ou a nota mudaram entre a leitura e o fecho (outra janela)? Então o que se ia selar já não é o que está gravado.
    const same = (a: unknown, b: unknown) => (a == null ? null : Number(a)) === (b == null ? null : Number(b));
    if (!same(day?.confirmedCash, data.state.confirmedCash) || !same(day?.confirmedMb, data.state.confirmedMb) || String(day?.note ?? "") !== String(data.state.note ?? "")) {
      return { ok: false as const, code: "CONFLICT" as const, message: "Os valores do dia mudaram entretanto. Atualiza a página e fecha outra vez." };
    }
    const at = utcStamp();
    const head = await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: "fechar", findingKey: null, data: {
      status, differenceCents: data.summary.differenceCents, alert: data.summary.alert, bookings: data.views.length, red: data.counts.red, amber: data.counts.amber,
    } });
    const seal = buildSeal({ day: o.day, city: o.city, summary: data.summary, states: data.states, justificationIds: data.justifications.map((j) => j.id), fileIds: data.files.map((f) => f.id), chainHead: head, status });
    await tx.execute(sql`UPDATE cash_confirm_days SET status = ${status}, differenceCents = ${data.summary.differenceCents}, alert = ${data.summary.alert},
      closedBy = ${o.userId}, closedAt = ${at}, sealHash = ${seal.hash}, sealJson = ${seal.json}, reopenReason = NULL, lastCheckedAt = ${at} WHERE day = ${o.day} AND city = ${o.city}`);
    await appendEvent(tx, { day: o.day, city: o.city, userId: o.userId, action: "selar", findingKey: null, data: { sealHash: seal.hash } });
    return { ok: true as const };
  });
  if (!res.ok) return res;
  await notifyDay({ day: o.day, city: o.city, kind: "close", summary: data.summary, status, byName: o.userName }).catch(() => {});
  return { ok: true, status, alert: data.summary.alert };
}

/**
 * O Jorge decide: uma justificação (aprovar/recusar) ou o dia inteiro (aprovar
 * = aprova todas as justificações por decidir). Quem decide não pode ser quem
 * justificou nem quem fechou o dia. Recusar reabre o dia.
 */
export async function decideConfirm(o: { day: string; city: HandoverCity; justificationId: number | null; decision: "aprovado" | "recusado"; note: string | null; userId: number }): Promise<{ ok: true; status: DayStatus } | Fail> {
  const note = (o.note ?? "").trim() || null;
  if (o.decision === "recusado" && (note ?? "").length < 10) return { ok: false, code: "BAD_REQUEST", message: "Para recusar, diz porquê (pelo menos 10 carateres)." };
  return inTx(async (tx) => {
    const day = await lockDay(tx, o.day, o.city);
    if (!day || isOpen(day.status)) return { ok: false as const, code: "CONFLICT" as const, message: "Só se aprova um dia depois de o João o fechar." };
    if (Number(day.closedBy) === o.userId) return { ok: false as const, code: "FORBIDDEN" as const, message: "Quem fechou o dia não o pode aprovar." };
    const pending = rowsOf(await tx.execute(sql`SELECT j.id, j.userId FROM cash_confirm_justifications j
      WHERE j.day = ${o.day} AND j.city = ${o.city}
        AND j.id = (SELECT MAX(j2.id) FROM cash_confirm_justifications j2 WHERE j2.findingKey = j.findingKey AND j2.day = j.day AND j2.city = j.city)
        AND NOT EXISTS (SELECT 1 FROM cash_confirm_decisions x WHERE x.justificationId = j.id)`));
    const at = utcStamp();
    const targets = o.justificationId == null ? pending : pending.filter((p) => Number(p.id) === o.justificationId);
    if (o.justificationId != null && !targets.length) return { ok: false as const, code: "NOT_FOUND" as const, message: "Justificação não encontrada ou já decidida." };
    if (targets.some((t) => Number(t.userId) === o.userId)) return { ok: false as const, code: "FORBIDDEN" as const, message: "Não podes decidir uma justificação tua." };
    for (const t of targets) {
      await tx.execute(sql`INSERT INTO cash_confirm_decisions (day, city, justificationId, decision, note, userId, at) VALUES (${o.day}, ${o.city}, ${Number(t.id)}, ${o.decision}, ${note}, ${o.userId}, ${at})`);
      await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: o.decision === "aprovado" ? "aprovar_justificacao" : "recusar_justificacao", findingKey: null, data: { justificationId: Number(t.id), note } });
    }
    let status: DayStatus = day.status as DayStatus;
    if (o.decision === "recusado") {
      status = "aberto";
      await tx.execute(sql`UPDATE cash_confirm_days SET status = 'aberto', reopenReason = ${`Recusado pelo Jorge: ${note}`}, approvedBy = NULL, approvedAt = NULL WHERE day = ${o.day} AND city = ${o.city}`);
      await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: "reabrir", findingKey: null, data: { reason: "recusado", note } });
    } else if (o.justificationId == null || (pending.length === targets.length && (day.alert ?? "none") === "none")) {
      // Com diferença > 30 € no dia, aprovar as justificações uma a uma não aprova o dia: o Jorge aprova o dia à parte.
      status = "aprovado";
      if (o.justificationId == null) await tx.execute(sql`INSERT INTO cash_confirm_decisions (day, city, justificationId, decision, note, userId, at) VALUES (${o.day}, ${o.city}, NULL, 'aprovado', ${note}, ${o.userId}, ${at})`);
      await tx.execute(sql`UPDATE cash_confirm_days SET status = 'aprovado', approvedBy = ${o.userId}, approvedAt = ${at} WHERE day = ${o.day} AND city = ${o.city}`);
      await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: "aprovar_dia", findingKey: null, data: { note } });
    }
    return { ok: true as const, status };
  });
}

/** Reabrir à mão (Caixa → gerir), com motivo. */
export async function reopenConfirmDay(o: { day: string; city: HandoverCity; reason: string; userId: number }): Promise<{ ok: true } | Fail> {
  const reason = o.reason.trim();
  if (reason.length < 10) return { ok: false, code: "BAD_REQUEST", message: "Diz porque reabres (pelo menos 10 carateres)." };
  return inTx(async (tx) => {
    const day = await lockDay(tx, o.day, o.city);
    if (isOpen(day?.status)) return { ok: false as const, code: "CONFLICT" as const, message: "O dia já está aberto." };
    await tx.execute(sql`UPDATE cash_confirm_days SET status = 'aberto', reopenReason = ${reason}, approvedBy = NULL, approvedAt = NULL WHERE day = ${o.day} AND city = ${o.city}`);
    await appendEvent(tx, { day: o.day, city: o.city, userId: o.userId, action: "reabrir", findingKey: null, data: { reason } });
    return { ok: true as const };
  });
}

// ─── Mês (para o Jorge) ─────────────────────────────────────────────────────

export async function confirmMonth(month: string, cities: readonly HandoverCity[]) {
  if (!/^\d{4}-\d{2}$/.test(month) || !cities.length) return [];
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT c.day, c.city, c.status, c.differenceCents, c.alert, ${DT("c.closedAt")} AS closedAt, uc.name AS closedByName, ${DT("c.approvedAt")} AS approvedAt, ua.name AS approvedByName, c.reopenReason,
      (SELECT COUNT(*) FROM cash_confirm_justifications j WHERE j.day = c.day AND j.city = c.city
         AND j.id = (SELECT MAX(j2.id) FROM cash_confirm_justifications j2 WHERE j2.findingKey = j.findingKey AND j2.day = j.day AND j2.city = j.city)
         AND NOT EXISTS (SELECT 1 FROM cash_confirm_decisions x WHERE x.justificationId = j.id)) AS pending
    FROM cash_confirm_days c LEFT JOIN users uc ON uc.id = c.closedBy LEFT JOIN users ua ON ua.id = c.approvedBy
    WHERE c.day LIKE ${`${month}-%`} AND c.city IN (${sql.join(cities.map((x) => sql`${x}`), sql`, `)}) ORDER BY c.day, c.city`));
  return rows.map((r) => ({
    day: String(r.day), city: String(r.city) as HandoverCity, status: String(r.status) as DayStatus, differenceCents: r.differenceCents == null ? null : Number(r.differenceCents),
    alert: r.alert ?? null, closedAt: r.closedAt ? String(r.closedAt).slice(0, 19) : null, closedByName: r.closedByName ?? null,
    approvedAt: r.approvedAt ? String(r.approvedAt).slice(0, 19) : null, approvedByName: r.approvedByName ?? null, reopenReason: r.reopenReason ?? null, pending: Number(r.pending ?? 0),
  }));
}

/** Link assinado (10 min) de um ficheiro do dia. */
export async function confirmFileUrl(o: { day: string; city: HandoverCity; fileId: number }): Promise<string | null> {
  const d = await db();
  const [f] = rowsOf(await d.execute(sql`SELECT storageKey FROM cash_confirm_files WHERE id = ${o.fileId} AND day = ${o.day} AND city = ${o.city} LIMIT 1`));
  if (!f?.storageKey) return null;
  const { storagePresignGet } = await import("./storage");
  return (await storagePresignGet(String(f.storageKey)))?.url ?? null;
}

// ─── Avisos ─────────────────────────────────────────────────────────────────

const CITY_LABEL: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };

async function notifyDay(o: { day: string; city: string; kind: "close" | "reopened"; summary?: DaySummary; status?: DayStatus; byName?: string | null; reason?: string }) {
  const { notify } = await import("./notify");
  const link = `/caixa?tab=confirmacao&dia=${o.day}&cidade=${o.city}`;
  const entity = { type: "cash_confirm_day", id: `${o.day}:${o.city}` };
  if (o.kind === "reopened") {
    await notify({ kind: "cash_confirm_alert", city: o.city, title: `Caixa ${CITY_LABEL[o.city] ?? o.city} ${o.day} reaberta`, body: o.reason ?? "A Multipark mudou uma reserva de um dia já fechado.", link, entity });
    return;
  }
  const s = o.summary!;
  if (s.alert === "none") return;
  const title = `Caixa ${CITY_LABEL[o.city] ?? o.city} ${o.day}: diferença de ${eur(s.differenceCents)}`;
  const body = `${o.byName ?? "O João"} fechou o dia com ${eur(s.differenceCents)} de diferença (esperado em dinheiro ${eur(s.expectedCashCents)}, MB ${eur(s.expectedMbCents)}). Fica a amarelo até aprovares.`;
  await notify({ kind: "cash_confirm_alert", city: o.city, title, body, link, entity });
  if (s.alert === "email") await notify({ kind: "cash_confirm_alert_email", city: o.city, title, body, link, entity });
}

// ─── Varredura dos dias fechados ────────────────────────────────────────────

/**
 * Diferenças entre o selo e o estado de agora: reservas cujo dinheiro mudou,
 * que entraram ou saíram do dia, ou com uma validação da Multipark que voltou
 * de "sim" a "não" (passar a "sim" depois do fecho é normal). Estados no
 * formato "<hash>|<cvd>". PURA.
 */
export function sealDrift(sealStates: Record<string, string>, now: Record<string, string>): { changed: string[]; added: string[]; removed: string[] } {
  const changed: string[] = [], added: string[] = [], removed: string[] = [];
  for (const [id, h] of Object.entries(now)) {
    if (!(id in sealStates)) { added.push(id); continue; }
    const [hashNow, flagsNow = ""] = h.split("|");
    const [hashSeal, flagsSeal = ""] = sealStates[id].split("|");
    const reverted = [...flagsSeal].some((f, k) => f === "1" && flagsNow[k] !== "1");
    if (hashNow !== hashSeal || reverted) changed.push(id);
  }
  for (const id of Object.keys(sealStates)) if (!(id in now)) removed.push(id);
  return { changed, added, removed };
}

/**
 * Relê os dias fechados dos últimos RECHECK_DAYS dias (os mais antigos primeiro
 * na verificação); se a Multipark mudou o conjunto ou o estado de alguma reserva
 * selada, o dia reabre ("reaberto") e o Jorge é avisado. Para no prazo.
 */
export async function recheckClosedConfirmDays(o: { deadlineAt: number; nowMs?: number }): Promise<{ checked: number; reopened: number; skipped: number }> {
  const d = await db();
  const { addDays } = await import("../shared/lisbonDay");
  const { currentCashDay } = await import("../shared/cashDayWindow");
  const since = addDays(currentCashDay(o.nowMs ?? Date.now()), -RECHECK_DAYS);
  const days = rowsOf(await d.execute(sql`SELECT day, city, sealJson FROM cash_confirm_days
    WHERE status IN ('fechado', 'a_aprovar', 'aprovado') AND day >= ${since} AND sealJson IS NOT NULL
    ORDER BY lastCheckedAt IS NULL DESC, lastCheckedAt ASC LIMIT 60`));
  let checked = 0, reopened = 0, skipped = 0;
  for (const row of days) {
    if (Date.now() > o.deadlineAt - 8_000) { skipped++; continue; }
    const day = String(row.day), city = String(row.city) as HandoverCity;
    let seal: any;
    try { seal = JSON.parse(String(row.sealJson)); } catch { skipped++; continue; }
    const data = await loadConfirmDay(day, city, undefined);
    if (!data.available || data.truncated) { skipped++; continue; } // sem dados completos não se conclui nada
    checked++;
    const drift = sealDrift(seal?.states ?? {}, data.states);
    const at = utcStamp();
    if (drift.changed.length || drift.added.length || drift.removed.length) {
      const reason = `A Multipark mudou depois do fecho: ${drift.changed.length} reserva(s) alteradas, ${drift.added.length} novas no dia, ${drift.removed.length} saíram do dia.`;
      const did = await inTx(async (tx) => {
        const cur = await lockDay(tx, day, city);
        if (isOpen(cur?.status)) return false;
        await tx.execute(sql`UPDATE cash_confirm_days SET status = 'reaberto', reopenedAt = ${at}, reopenReason = ${reason}, lastCheckedAt = ${at} WHERE day = ${day} AND city = ${city}`);
        await appendEvent(tx, { day, city, at, userId: null, action: "reaberto_multipark", findingKey: null, data: { ...drift, changed: drift.changed.slice(0, 50), added: drift.added.slice(0, 50), removed: drift.removed.slice(0, 50) } });
        return true;
      });
      if (did) { reopened++; await notifyDay({ day, city, kind: "reopened", reason }).catch(() => {}); }
    } else {
      await d.execute(sql`UPDATE cash_confirm_days SET lastCheckedAt = ${at} WHERE day = ${day} AND city = ${city}`);
    }
  }
  return { checked, reopened, skipped };
}

export { FINDING_LABEL };
