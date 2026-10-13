/**
 * Confirmação da caixa reserva a reserva — servidor (plano
 * docs/plans/2026-10-13-confirmacao-caixa-plano.md; decisões do Jorge de 13 out 2026, §26/§27).
 *
 * Fluxo: os condutores entregam ao team leader, que fecha na Multipark e
 * declara na Passagem de turno o dinheiro e o MB recebidos e o total que dava a
 * caixa. No dia seguinte o João abre Caixa → Confirmação (cidade × dia):
 *  - vê as saídas do dia lado a lado (preço quando nasceu, original, final,
 *    pago por método, crédito/taxa, 3 validações) e o dinheiro de balcão das
 *    outras reservas com pagamentos no dia, com os achados;
 *  - anexa os talões MB, justifica os vermelhos, conta o envelope e os talões e
 *    fecha. Diferença > 30 € (dinheiro e MB em valor absoluto), justificações por
 *    aprovar ou dia já reaberto → "à espera do Jorge" + aviso na app; > 70 € →
 *    também email. O Jorge aprova ou recusa (recusar reabre e avisa o João).
 *  - Varredura (cron próprio, de hora a hora): relê os dias fechados dos últimos
 *    45 dias com os parques do selo; se mudou o dinheiro de uma saída selada, os
 *    pagamentos de balcão do dia, as declarações/despesas/taxas, ou uma
 *    validação voltou a "não", o dia reabre e o Jorge é avisado.
 *
 * Nunca escreve na Multipark. Na nossa BD: `cash_confirm_days` (estado, a única
 * mutável) e tabelas SÓ ACRÉSCIMO (eventos em cadeia de hashes, justificações,
 * decisões, ficheiros, retiradas, leituras da Stripe) — um teste garante que não
 * há UPDATE/DELETE nelas, e o ecrã confere a cadeia, o selo e que cada
 * justificação/decisão/ficheiro tem o seu evento. Falha fechado.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bookingFindings, buildBookingView, bookingSealState, hasCounterInDay, summarySealState, validationFlags, isCheckoutKind, offCounterOf, feeSplitOf,
  canonicalJson, closeBlockers, daySummary, justificationProblem, justificationValid, statusAfterClose, toCents, eur, normText,
  ORIGIN_LATE_MS, type BookingView, type ConfirmOrigin, type DayStatus, type DaySummary, type Finding, type InDay,
  type JustificationRef, type MbReceiptRef, type ShiftDeclaration, type StripeCheck,
} from "../shared/cashConfirm";
import type { HandoverCity } from "./shiftExpenses";

export const CONFIRM_CITIES: readonly HandoverCity[] = ["lisbon", "porto", "faro"];
export const GENESIS_HASH = "0".repeat(64);
export const STRIPE_CONFIRM_MAX = 300;
const STRIPE_CONCURRENCY = 6;
/** Uma leitura "succeeded" da Stripe vale isto; as outras relêem-se sempre ao abrir o dia. */
const STRIPE_FRESH_MS = 24 * 3_600_000;
/** Quantos dias para trás a varredura relê os dias fechados. */
export const RECHECK_DAYS = 45;
/** Ações que contam como "mexer no dia" (quem as fez não pode aprovar). */
const AUTHOR_ACTIONS = new Set(["justificar", "anexar_talao", "anexar_comprovativo", "retirar_ficheiro", "confirmar_valores", "fechar", "selar"]);

type Db = { execute: (q: any) => Promise<unknown>; transaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T> };
type FailCode = "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "INTERNAL_SERVER_ERROR";
type Fail = { ok: false; code: FailCode; message: string };

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
/** DATETIME(3) → "YYYY-MM-DD HH:MM:SS.mmm" (o mesmo texto que entrou no hash). */
const DT = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s.%f')`);
const ms3 = (v: unknown) => (v == null ? null : String(v).slice(0, 23));
/** Agora em UTC com milissegundos ("YYYY-MM-DD HH:MM:SS.mmm"): o que se grava e entra no hash. */
export const utcStamp = (ms: number = Date.now()) => new Date(ms).toISOString().slice(0, 23).replace("T", " ");
const isoOf = (v: unknown) => (v ? `${String(v).slice(0, 23).replace(" ", "T")}Z` : null);

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

export type StoredEvent = ChainEvent & { id: number; prevHash: string; hash: string };

/** Confere a cadeia de um dia (linhas por ordem de id). PURA. */
export function verifyChain(rows: ReadonlyArray<StoredEvent>): { ok: boolean; brokenAt: number | null } {
  let prev = GENESIS_HASH;
  for (const r of rows) {
    if (r.prevHash !== prev || eventHash(prev, r) !== r.hash) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, brokenAt: null };
}

/**
 * Integridade do dia: cadeia, selo (sha256 do JSON = hash gravado = hash do
 * evento "selar") e cada justificação / decisão / ficheiro / retirada com o
 * seu evento (um INSERT direto, por fora da app, aparece aqui). PURA.
 */
export function verifyIntegrity(o: {
  events: ReadonlyArray<StoredEvent>;
  seal: { json: string | null; hash: string | null };
  justificationIds: readonly number[]; decisionIds: readonly number[]; fileIds: readonly number[]; removedFileIds: readonly number[];
}): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const chain = verifyChain(o.events);
  if (!chain.ok) problems.push(`Cadeia quebrada no evento #${chain.brokenAt}.`);
  const ids = (action: string | string[], field: string) => {
    const acts = new Set(Array.isArray(action) ? action : [action]);
    return new Set(o.events.filter((e) => acts.has(e.action)).map((e) => Number((e.data as any)?.[field])).filter(Number.isFinite));
  };
  if (o.seal.json != null || o.seal.hash != null) {
    const h = o.seal.json == null ? null : createHash("sha256").update(o.seal.json, "utf8").digest("hex");
    const lastSeal = [...o.events].reverse().find((e) => e.action === "selar");
    if (h !== o.seal.hash || (lastSeal && (lastSeal.data as any)?.sealHash !== o.seal.hash) || !lastSeal) problems.push("O selo do dia não bate com o registo.");
  }
  const j = ids("justificar", "justificationId"), d = ids(["aprovar_justificacao", "recusar_justificacao", "aprovar_dia"], "decisionId");
  const f = ids(["anexar_talao", "anexar_comprovativo"], "fileId"), r = ids("retirar_ficheiro", "fileId");
  const miss = (list: readonly number[], set: Set<number>, what: string) => { const m = list.filter((x) => !set.has(x)); if (m.length) problems.push(`${what} sem registo: #${m.slice(0, 5).join(", #")}.`); };
  miss(o.justificationIds, j, "Justificações"); miss(o.decisionIds, d, "Decisões"); miss(o.fileIds, f, "Ficheiros"); miss(o.removedFileIds, r, "Ficheiros retirados");
  return { ok: problems.length === 0, problems };
}

/** Linha da cidade × dia trancada (cria-a se faltar). Dentro de uma transação. */
async function lockDay(tx: Db, day: string, city: string): Promise<any> {
  await tx.execute(sql`INSERT IGNORE INTO cash_confirm_days (day, city, status) VALUES (${day}, ${city}, 'aberto')`);
  const [row] = rowsOf(await tx.execute(sql`SELECT * FROM cash_confirm_days WHERE day = ${day} AND city = ${city} FOR UPDATE`));
  return row;
}

async function chainHeadOf(tx: Db, day: string, city: string): Promise<string> {
  const [last] = rowsOf(await tx.execute(sql`SELECT hash FROM cash_confirm_events WHERE day = ${day} AND city = ${city} ORDER BY id DESC LIMIT 1`));
  return last?.hash ? String(last.hash) : GENESIS_HASH;
}

/** Acrescenta um evento à cadeia do dia (chamar com o dia trancado). Devolve o hash novo. */
async function appendEvent(tx: Db, e: Omit<ChainEvent, "at"> & { at?: string }): Promise<string> {
  const at = e.at ?? utcStamp();
  const prev = await chainHeadOf(tx, e.day, e.city);
  const ev: ChainEvent = { day: e.day, city: e.city, at, userId: e.userId, action: e.action, findingKey: e.findingKey, data: e.data ?? null };
  const hash = eventHash(prev, ev);
  await tx.execute(sql`INSERT INTO cash_confirm_events (day, city, at, userId, action, findingKey, data, prevHash, hash)
    VALUES (${ev.day}, ${ev.city}, ${at}, ${ev.userId}, ${ev.action}, ${ev.findingKey}, ${canonicalJson(ev.data)}, ${prev}, ${hash})`);
  return hash;
}

async function lastInsertId(tx: Db): Promise<number> {
  const [r] = rowsOf(await tx.execute(sql`SELECT LAST_INSERT_ID() AS id`));
  return Number(r?.id ?? 0);
}

async function inTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  const d = await db();
  if (!d.transaction) throw new Error("Transações indisponíveis");
  return d.transaction(fn as any);
}

// ─── Leituras da nossa BD ───────────────────────────────────────────────────

/** 1.º webhook BOOKING_CREATED de cada reserva (a origem independente do preço e das marcas). */
async function originsOf(d: Db, bookingIds: readonly string[]): Promise<Map<string, ConfirmOrigin>> {
  const out = new Map<string, ConfirmOrigin>();
  const ids = [...new Set(bookingIds.filter(Boolean))];
  const D = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s')`);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = rowsOf(await d.execute(sql`SELECT s.bookingId, s.bookingPrice, s.originalBookingPrice, s.pro, s.partnerId, s.campaignId, s.source, ${D("s.checkOut")} AS checkOut,
        ${D("s.receivedAt")} AS receivedAt, ${D("s.dbReadAt")} AS dbReadAt, ${D("s.eventCreatedAt")} AS eventCreatedAt
      FROM multipark_webhook_snapshots s
      JOIN (SELECT bookingId, MIN(id) AS id FROM multipark_webhook_snapshots
             WHERE eventType = 'BOOKING_CREATED' AND bookingId IN (${sql.join(chunk.map((x) => sql`${x}`), sql`, `)}) GROUP BY bookingId) f ON f.id = s.id`));
    for (const r of rows) {
      const born = isoOf(r.eventCreatedAt);
      const read = isoOf(r.dbReadAt) ?? isoOf(r.receivedAt);
      out.set(String(r.bookingId), {
        source: "webhook",
        bookingPrice: r.bookingPrice == null ? null : Number(r.bookingPrice),
        originalBookingPrice: r.originalBookingPrice == null ? null : Number(r.originalBookingPrice),
        checkOut: isoOf(r.checkOut), receivedAt: isoOf(r.receivedAt),
        pro: r.pro == null ? null : Number(r.pro) === 1 || r.pro === true,
        partnerId: r.partnerId ? String(r.partnerId) : null,
        campaignId: r.campaignId ? String(r.campaignId) : null,
        fromDb: r.source === "multipark_db" || r.source === "db_retry",
        late: !!born && !!read && Date.parse(read) - Date.parse(born) > ORIGIN_LATE_MS,
      });
    }
  }
  return out;
}

async function shiftDeclarations(d: Db, day: string, city: string): Promise<ShiftDeclaration[]> {
  const rows = rowsOf(await d.execute(sql`SELECT shift, cashierCashReceived, cashierMbReceived, cashierMultiparkTotal, filledByName, filledById, createdById, cashierDeclaredById
    FROM shift_handovers WHERE handoverDate = ${day} AND city = ${city}`));
  const n = (v: unknown) => (v == null ? null : Number(v));
  return rows.filter((r) => r.shift === "morning" || r.shift === "night").map((r) => ({
    shift: r.shift, cash: n(r.cashierCashReceived), mb: n(r.cashierMbReceived), multiparkTotal: n(r.cashierMultiparkTotal),
    byName: r.filledByName ?? null,
    // Quem escreveu os valores da caixa (registado na gravação desde a 0635); para as antigas, quem criou a passagem.
    byId: r.cashierDeclaredById != null ? Number(r.cashierDeclaredById) : r.createdById != null ? Number(r.createdById) : r.filledById == null ? null : Number(r.filledById),
  }));
}

export interface DayFile { id: number; bookingId: string | null; kind: string; amountCents: number | null; mime: string; size: number; sha256: string; uploadedAt: string; byName: string | null; removed: boolean }

async function dayFiles(d: Db, day: string, city: string): Promise<DayFile[]> {
  const rows = rowsOf(await d.execute(sql`SELECT f.id, f.bookingId, f.kind, f.amountCents, f.mime, f.size, f.sha256, ${DT("f.uploadedAt")} AS uploadedAt, u.name AS byName,
      EXISTS (SELECT 1 FROM cash_confirm_file_removals r WHERE r.fileId = f.id) AS removed
    FROM cash_confirm_files f LEFT JOIN users u ON u.id = f.uploadedBy WHERE f.day = ${day} AND f.city = ${city} ORDER BY f.id`));
  return rows.map((r) => ({
    id: Number(r.id), bookingId: r.bookingId ?? null, kind: String(r.kind), amountCents: r.amountCents == null ? null : Number(r.amountCents),
    mime: String(r.mime), size: Number(r.size), sha256: String(r.sha256), uploadedAt: String(ms3(r.uploadedAt)), byName: r.byName ?? null, removed: Number(r.removed) === 1,
  }));
}

export interface DayJustification extends JustificationRef { color: string; byName: string | null; at: string; userId: number; decidedByName: string | null; decisionNote: string | null }

/** Última justificação por achado + a última decisão do Jorge sobre ela; ids de todas as justificações e decisões (integridade). */
async function justificationsOf(d: Db, day: string, city: string): Promise<{ latest: Map<string, DayJustification>; allIds: number[]; decisionIds: number[] }> {
  const rows = rowsOf(await d.execute(sql`SELECT j.id, j.findingKey, j.code, j.color, j.amountCents, j.reason, j.explanation, j.fileIds, j.userId, ${DT("j.at")} AS at, u.name AS byName
    FROM cash_confirm_justifications j LEFT JOIN users u ON u.id = j.userId WHERE j.day = ${day} AND j.city = ${city} ORDER BY j.id`));
  const decs = rowsOf(await d.execute(sql`SELECT x.id, x.justificationId, x.decision, x.note, u.name AS byName FROM cash_confirm_decisions x LEFT JOIN users u ON u.id = x.userId
    WHERE x.day = ${day} AND x.city = ${city} ORDER BY x.id`));
  const lastDec = new Map<number, any>();
  for (const x of decs) if (x.justificationId != null) lastDec.set(Number(x.justificationId), x);
  const latest = new Map<string, DayJustification>();
  for (const r of rows) {
    let fileIds: number[] = [];
    try { fileIds = (JSON.parse(String(r.fileIds ?? "[]")) as unknown[]).map(Number).filter(Number.isFinite); } catch { fileIds = []; }
    const dec = lastDec.get(Number(r.id));
    latest.set(String(r.findingKey), {
      id: Number(r.id), findingKey: String(r.findingKey), code: String(r.code), color: String(r.color), amountCents: Number(r.amountCents ?? 0),
      reason: String(r.reason), explanation: String(r.explanation), fileIds,
      decision: dec?.decision === "aprovado" || dec?.decision === "recusado" ? dec.decision : null,
      userId: Number(r.userId), byName: r.byName ?? null, at: String(ms3(r.at)), decidedByName: dec?.byName ?? null, decisionNote: dec?.note ?? null,
    });
  }
  return { latest, allIds: rows.map((r) => Number(r.id)), decisionIds: decs.map((x) => Number(x.id)) };
}

// ─── Stripe (leituras guardadas; nunca lança) ───────────────────────────────

export type StripeMode = "fetch" | "db";

async function stripeChecks(d: Db, ids: readonly string[], mode: StripeMode): Promise<{ available: boolean; checks: Map<string, StripeCheck | null>; unread: number; reason: string | null }> {
  const [{ cashFlags }, { stripeKeyState, stripeGetPayment }] = await Promise.all([import("./cashExternal"), import("./external/stripe")]);
  const want = [...new Set(ids.filter(Boolean))];
  const checks = new Map<string, StripeCheck | null>();
  const flags = await cashFlags().catch(() => ({ stripe: false }));
  if (!flags.stripe) return { available: false, checks, unread: want.length, reason: "A verificação da Stripe está desligada (Definições → Automações → CASH_STRIPE_CHECK)." };
  if (stripeKeyState() !== "ok") return { available: false, checks, unread: want.length, reason: "Falta a chave de leitura da Stripe (STRIPE_READ_KEY, restrita rk_)." };
  const stored = new Map<string, { check: StripeCheck | null; at: number }>();
  for (let i = 0; i < want.length; i += 500) {
    const chunk = want.slice(i, i + 500);
    const rows = rowsOf(await d.execute(sql`SELECT c.intentId, c.found, c.status, c.receivedCents, c.refundedCents, c.disputed, ${DT("c.checkedAt")} AS checkedAt FROM cash_confirm_stripe_checks c
      JOIN (SELECT intentId, MAX(id) AS id FROM cash_confirm_stripe_checks WHERE intentId IN (${sql.join(chunk.map((x) => sql`${x}`), sql`, `)}) GROUP BY intentId) m ON m.id = c.id`));
    for (const r of rows) {
      const check: StripeCheck | null = Number(r.found) === 1 ? { status: r.status ?? null, received: r.receivedCents == null ? null : Number(r.receivedCents) / 100, refunded: r.refundedCents == null ? null : Number(r.refundedCents) / 100, disputed: Number(r.disputed) === 1 } : null;
      stored.set(String(r.intentId), { check, at: Date.parse(isoOf(r.checkedAt) ?? "") || 0 });
    }
  }
  const now = Date.now();
  const todo: string[] = [];
  for (const id of want) {
    const s = stored.get(id);
    if (s) checks.set(id, s.check);
    if (mode === "fetch" && (!s || s.check?.status !== "succeeded" || now - s.at > STRIPE_FRESH_MS)) todo.push(id);
  }
  const batch = todo.slice(0, STRIPE_CONFIRM_MAX);
  let saveFailed = 0;
  for (let i = 0; i < batch.length; i += STRIPE_CONCURRENCY) {
    await Promise.all(batch.slice(i, i + STRIPE_CONCURRENCY).map(async (id) => {
      const r = await stripeGetPayment(id);
      if (!r.ok) return; // sem resposta: fica com o que estava guardado (ou por ler)
      const v: StripeCheck | null = r.payment ? { status: r.payment.status, received: r.payment.received, refunded: r.payment.refunded, disputed: r.payment.disputed } : null;
      checks.set(id, v);
      await d.execute(sql`INSERT INTO cash_confirm_stripe_checks (intentId, found, status, receivedCents, refundedCents, disputed, checkedAt)
        VALUES (${id}, ${v ? 1 : 0}, ${v?.status ?? null}, ${v?.received == null ? null : toCents(v.received)}, ${v?.refunded == null ? null : toCents(v.refunded)}, ${v?.disputed ? 1 : 0}, ${utcStamp()})`)
        .catch((err) => { saveFailed++; console.warn("[cashConfirm] gravar leitura da Stripe falhou:", String((err as Error)?.message ?? err).slice(0, 160)); });
    }));
  }
  const unread = want.filter((id) => !checks.has(id)).length;
  const reason = [unread ? `${unread} pagamento(s) online ainda por ler na Stripe.` : null, saveFailed ? `${saveFailed} leitura(s) da Stripe não ficaram gravadas (o fecho não as vê): tenta outra vez.` : null].filter(Boolean).join(" ");
  return { available: true, checks, unread, reason: reason || null };
}

// ─── O dia ──────────────────────────────────────────────────────────────────

export interface ConfirmDayData {
  available: true;
  day: string; city: HandoverCity; window: string; dayClosed: boolean;
  status: DayStatus;
  state: {
    confirmedCash: number | null; confirmedMb: number | null; note: string | null;
    closedById: number | null; closedByName: string | null; closedAt: string | null; approvedByName: string | null; approvedAt: string | null;
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
  stripe: { available: boolean; reason: string | null; unread: number };
  integrity: { ok: boolean; problems: string[]; events: number };
  chainHead: string;
  /** Pessoas que mexeram no dia (não podem aprovar). */
  authors: number[];
  reopenedBefore: boolean;
  events: Array<{ id: number; at: string; action: string; findingKey: string | null; byName: string | null; data: unknown }>;
  /** Estados por reserva, os parques e as contas (para o selo e para a varredura). */
  states: Record<string, string>;
  parkIds: string[];
}
export type ConfirmDayResult = ConfirmDayData | { available: false; reason: string };

const stateHash = (o: unknown) => createHash("sha256").update(canonicalJson(o), "utf8").digest("hex");

function parseJson(v: unknown): unknown {
  if (v == null) return null;
  try { return JSON.parse(String(v)); } catch { return String(v); }
}

/** Monta o dia (lê tudo, calcula achados). Nunca lança por falta da Multipark: devolve { available:false }. */
export async function loadConfirmDay(day: string, city: HandoverCity, cities: string[] | undefined, opts: { stripe?: StripeMode; parkIds?: readonly string[]; viewerId?: number | null } = {}): Promise<ConfirmDayResult> {
  const [{ readConfirmDay }, { buildParksSql, mapParks }, { multiparkDbQuery }, { safeMultiparkRead }, win, { getSetting }, { shiftExpensesByCity }, { isOperatedPark, cityOfParkName }] = await Promise.all([
    import("./multiparkDb/cashConfirm"), import("./multiparkDb/dayBookings"), import("./multiparkDb/client"), import("./multiparkDb/read"),
    import("../shared/cashDayWindow"), import("./appSettings"), import("./shiftExpenses"), import("./cashDay"),
  ]);
  const excluded: string[] = ((await getSetting("operations.excludedParks")) as string[] | null) ?? [];
  const range = win.cashDayRangeUtc(day);
  const r = await safeMultiparkRead("confirmação da caixa", async () => {
    const parks = opts.parkIds ? [...opts.parkIds] : mapParks(await multiparkDbQuery(buildParksSql().sql), cities)
      .filter((p) => isOperatedPark(p, excluded) && cityOfParkName(p.cityName) === city).map((p) => p.id);
    return { parks, read: await readConfirmDay({ parkIds: parks, start: range.start, end: range.end }) };
  });
  if (!r.available) return { available: false, reason: r.reason };
  const d = await db();
  const rows = r.data.read.rows;
  const partners = new Set(r.data.read.partnerNames.map(normText));
  const [origins, shifts, files, justs, dayRows, expenses, evRows] = await Promise.all([
    originsOf(d, rows.map((x) => x.live.id)),
    shiftDeclarations(d, day, city),
    dayFiles(d, day, city),
    justificationsOf(d, day, city),
    d.execute(sql`SELECT c.*, ${DT("c.closedAt")} AS closedAtS, ${DT("c.approvedAt")} AS approvedAtS, uc.name AS closedByName, ua.name AS approvedByName
      FROM cash_confirm_days c LEFT JOIN users uc ON uc.id = c.closedBy LEFT JOIN users ua ON ua.id = c.approvedBy WHERE c.day = ${day} AND c.city = ${city}`).then(rowsOf),
    shiftExpensesByCity(day),
    d.execute(sql`SELECT e.id, e.day, e.city, ${DT("e.at")} AS at, e.userId, e.action, e.findingKey, e.data, e.prevHash, e.hash, u.name AS byName
      FROM cash_confirm_events e LEFT JOIN users u ON u.id = e.userId WHERE e.day = ${day} AND e.city = ${city} ORDER BY e.id`).then(rowsOf),
  ]);
  const st = dayRows[0] ?? null;
  const inWindow = (iso: string | null) => !!iso && Date.parse(iso) >= range.startMs && Date.parse(iso) < range.endMs;

  // Stripe só para as saídas do dia com pagamentos online (o pré-pago confere-se no dia da saída).
  const onlineIntents = rows.filter((x) => isCheckoutKind(x.kind) && x.live.payments.some((p) => /online|stripe|mb ?way/i.test(p.method ?? ""))).flatMap((x) => x.live.intents.map((i) => i.id));
  const stripe = await stripeChecks(d, onlineIntents, opts.stripe ?? "fetch");
  const activeFiles = files.filter((f) => !f.removed);
  const activeIds = new Set(activeFiles.map((f) => f.id));
  const receipts: MbReceiptRef[] = activeFiles.filter((f) => f.kind === "talao_mb" && f.amountCents != null).map((f) => ({ id: f.id, amountCents: f.amountCents as number, bookingId: f.bookingId }));

  const views: BookingView[] = [];
  const states: Record<string, string> = {};
  const windowPayments: Array<{ amount: number | null; method: string | null }> = [];
  const fees = { cash: 0, mb: 0 };
  for (const row of rows) {
    const live = row.live;
    const origin = origins.get(live.id) ?? null;
    const off = offCounterOf(live, origin);
    const windowIds = new Set(live.payments.filter((p) => inWindow(p.recordedAt)).map((p) => p.id));
    for (const p of live.payments) if (windowIds.has(p.id)) windowPayments.push({ amount: p.amount, method: p.method });
    if (isCheckoutKind(row.kind)) { const f = feeSplitOf(live, windowIds, off, partners); fees.cash += f.cash; fees.mb += f.mb; }
    const findings: Finding[] = bookingFindings({ live, origin, windowPaymentIds: windowIds, inDay: row.kind, stripe: stripe.checks, stripeAvailable: stripe.available, mbReceipts: receipts, partnerNames: partners });
    views.push(buildBookingView({ live, origin, inDay: row.kind, findings, windowPaymentIds: windowIds, justifications: justs.latest, activeFileIds: activeIds, partnerNames: partners }));
    const short: Record<InDay, string> = { checkout: "c", checkout_pending: "k", cancelled: "x", payment_only: "p" };
    states[live.id] = [stateHash(bookingSealState(live, row.kind, windowIds, partners, off)), isCheckoutKind(row.kind) ? validationFlags(live) : "", short[row.kind], hasCounterInDay(live, windowIds, partners, off) ? "1" : "0"].join("|");
  }
  const RANK = { red: 0, amber: 1, green: 2 } as const;
  views.sort((a, b) => RANK[a.color] - RANK[b.color] || (b.findings.length - a.findings.length) || String(a.checkOut ?? "").localeCompare(String(b.checkOut ?? "")));
  const confirmed = st ? { cash: st.confirmedCash == null ? null : Number(st.confirmedCash), mb: st.confirmedMb == null ? null : Number(st.confirmedMb) } : null;
  const se = expenses.get(city) ?? { total: 0, count: 0 };
  // As liquidações (acertos PRO/parceiro) não são dinheiro de balcão: o método já as põe fora (CARD/PRO_PLAN), e as contas só somam dinheiro e MB.
  const summary = daySummary({ windowPayments, shiftExpenses: se.total, fees, shifts, confirmed, partnerNames: partners });
  const status: DayStatus = (st?.status as DayStatus) ?? "aberto";
  const truncated = r.data.read.truncated;
  const events: StoredEvent[] = evRows.map((e) => ({ id: Number(e.id), day: String(e.day), city: String(e.city), at: String(ms3(e.at)), userId: e.userId == null ? null : Number(e.userId), action: String(e.action), findingKey: e.findingKey ?? null, data: parseJson(e.data), prevHash: String(e.prevHash), hash: String(e.hash) }));
  const integrity = verifyIntegrity({ events, seal: { json: st?.sealJson ?? null, hash: st?.sealHash ?? null }, justificationIds: justs.allIds, decisionIds: justs.decisionIds, fileIds: files.map((f) => f.id), removedFileIds: files.filter((f) => f.removed).map((f) => f.id) });
  const reopenedBefore = events.some((e) => e.action === "reabrir" || e.action === "reaberto_multipark");
  const isOpenNow = status === "aberto" || status === "reaberto";
  const blockers = isOpenNow
    ? [
        ...closeBlockers({
          dayClosedAt3am: win.isCashDayClosed(day), truncated, multiparkOk: true, stripe: { available: stripe.available, unread: stripe.unread },
          views, summary, noteLen: String(st?.note ?? "").trim().length,
          closerId: opts.viewerId ?? null, declarantIds: shifts.map((s) => s.byId).filter((x): x is number => x != null),
        }),
        ...(integrity.ok ? [] : ["O registo do dia não está íntegro: avisa o Jorge (não se fecha um dia com o registo adulterado)."]),
      ]
    : [];
  return {
    available: true, day, city, window: win.cashDayWindowLabel(day), dayClosed: win.isCashDayClosed(day),
    status,
    state: {
      confirmedCash: confirmed?.cash ?? null, confirmedMb: confirmed?.mb ?? null, note: st?.note ?? null,
      closedById: st?.closedBy == null ? null : Number(st.closedBy), closedByName: st?.closedByName ?? null, closedAt: ms3(st?.closedAtS),
      approvedByName: st?.approvedByName ?? null, approvedAt: ms3(st?.approvedAtS), reopenReason: st?.reopenReason ?? null, sealHash: st?.sealHash ?? null,
    },
    summary, shifts, views,
    counts: { bookings: views.length, red: views.filter((v) => v.color === "red").length, amber: views.filter((v) => v.color === "amber").length, green: views.filter((v) => v.color === "green").length },
    files, justifications: [...justs.latest.values()], blockers, truncated,
    stripe: { available: stripe.available, reason: stripe.reason, unread: stripe.unread },
    integrity: { ...integrity, events: events.length },
    chainHead: events.length ? events[events.length - 1].hash : GENESIS_HASH,
    authors: [...new Set(events.filter((e) => AUTHOR_ACTIONS.has(e.action) && e.userId != null).map((e) => e.userId as number))],
    reopenedBefore,
    events: events.slice(-80).reverse().map((e) => ({ id: e.id, at: e.at.slice(0, 19), action: e.action, findingKey: e.findingKey, byName: evRows.find((x) => Number(x.id) === e.id)?.byName ?? null, data: e.data })),
    states, parkIds: r.data.parks,
  };
}

const isOpen = (s: string | null | undefined) => !s || s === "aberto" || s === "reaberto";

// ─── Escritas ───────────────────────────────────────────────────────────────

/** Justificar um achado (o João). O servidor relê o dia: o achado tem de existir agora, com este valor. */
export async function justifyFinding(o: { day: string; city: HandoverCity; cities: string[] | undefined; findingKey: string; reason: string; explanation: string; fileIds: number[]; userId: number }): Promise<{ ok: true; id: number } | Fail> {
  const data = await loadConfirmDay(o.day, o.city, o.cities, { stripe: "db", viewerId: o.userId });
  if (!data.available) return { ok: false, code: "INTERNAL_SERVER_ERROR", message: `BD da Multipark sem resposta: ${data.reason}` };
  if (!isOpen(data.status)) return { ok: false, code: "CONFLICT", message: "O dia já está fechado: só o Jorge o pode reabrir." };
  const f = data.views.flatMap((v) => v.findings).find((x) => x.key === o.findingKey);
  if (!f) return { ok: false, code: "NOT_FOUND", message: "Este achado já não existe (a Multipark mudou?). Atualiza a página." };
  if (f.color === "green") return { ok: false, code: "BAD_REQUEST", message: "Não há nada a justificar." };
  const fileIds = [...new Set(o.fileIds)];
  const valid = new Set(data.files.filter((x) => !x.removed && x.kind === "comprovativo" && x.bookingId === f.bookingId).map((x) => x.id));
  if (fileIds.some((id) => !valid.has(id))) return { ok: false, code: "BAD_REQUEST", message: "Um dos comprovativos não é desta reserva ou foi retirado." };
  // Um comprovativo serve uma só justificação (a não ser que seja a deste mesmo achado).
  const usedElsewhere = new Set(data.justifications.filter((j) => j.findingKey !== f.key).flatMap((j) => j.fileIds));
  if (fileIds.some((id) => usedElsewhere.has(id))) return { ok: false, code: "BAD_REQUEST", message: "Esse comprovativo já justifica outro achado: anexa um próprio para este." };
  const problem = justificationProblem({ finding: f, reason: o.reason, explanation: o.explanation, fileCount: fileIds.length });
  if (problem) return { ok: false, code: "BAD_REQUEST", message: problem };
  let id = 0;
  await inTx(async (tx) => {
    const day = await lockDay(tx, o.day, o.city);
    if (!isOpen(day?.status)) throw Object.assign(new Error("O dia já está fechado."), { code: "CONFLICT" });
    const at = utcStamp();
    await tx.execute(sql`INSERT INTO cash_confirm_justifications (day, city, findingKey, bookingId, code, color, amountCents, reason, explanation, fileIds, userId, at)
      VALUES (${o.day}, ${o.city}, ${f.key}, ${f.bookingId}, ${f.code}, ${f.color}, ${f.amountCents}, ${o.reason}, ${o.explanation.trim()}, ${JSON.stringify(fileIds)}, ${o.userId}, ${at})`);
    id = await lastInsertId(tx);
    await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: "justificar", findingKey: f.key, data: { justificationId: id, code: f.code, color: f.color, amountCents: f.amountCents, reason: o.reason, explanation: o.explanation.trim(), fileIds } });
  });
  return { ok: true, id };
}

/** Limite do ficheiro já descodificado (base64 ≈ +33%: ~4,4 MB no pedido, abaixo dos ~4,5 MB da Vercel). */
export const FILE_MAX_BYTES = 3_300_000;
const FILE_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;

/** Anexar um talão MB (com valor) ou um comprovativo, sempre de uma reserva. O mesmo ficheiro (sha256) nunca serve duas vezes. */
export async function uploadConfirmFile(o: { day: string; city: HandoverCity; bookingId: string | null; kind: "talao_mb" | "comprovativo"; amount: number | null; base64: string; mimeType: string; userId: number }): Promise<{ ok: true; id: number } | Fail> {
  if (!FILE_MIME.test(o.mimeType)) return { ok: false, code: "BAD_REQUEST", message: "Só fotos (JPG, PNG, WebP, HEIC) ou PDF." };
  if (!o.bookingId) return { ok: false, code: "BAD_REQUEST", message: "O ficheiro tem de ser de uma reserva." };
  const buf = Buffer.from(o.base64, "base64");
  if (!buf.length || buf.length > FILE_MAX_BYTES) return { ok: false, code: "BAD_REQUEST", message: "Ficheiro vazio ou maior do que 3,3 MB (as fotos são reduzidas antes de enviar; um PDF grande tem de ser comprimido)." };
  if (o.kind === "talao_mb" && (o.amount == null || !(o.amount > 0))) return { ok: false, code: "BAD_REQUEST", message: "O talão precisa do valor." };
  const sha = createHash("sha256").update(buf).digest("hex");
  const d = await db();
  const [dup] = rowsOf(await d.execute(sql`SELECT id FROM cash_confirm_files WHERE sha256 = ${sha} LIMIT 1`));
  if (dup) return { ok: false, code: "CONFLICT", message: "Este ficheiro já foi anexado antes. O mesmo talão/comprovativo não pode servir duas vezes." };
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
      id = await lastInsertId(tx);
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

/** O João grava o dinheiro do envelope, o MB dos talões e a nota do dia (só com o dia aberto). */
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

/** Selo do dia: contas + estado de cada reserva + parques + cabeça da cadeia. PURA. */
export function buildSeal(o: { day: string; city: string; summary: DaySummary; states: Record<string, string>; parkIds: readonly string[]; justificationIds: number[]; fileIds: number[]; chainHead: string; status: DayStatus }) {
  const seal = {
    v: 2, day: o.day, city: o.city, status: o.status, summary: summarySealState(o.summary), result: { differenceCents: o.summary.differenceCents, absDifferenceCents: o.summary.absDifferenceCents, alert: o.summary.alert },
    states: o.states, parkIds: [...o.parkIds].sort(), justificationIds: [...o.justificationIds].sort((a, b) => a - b), fileIds: [...o.fileIds].sort((a, b) => a - b), chainHead: o.chainHead,
  };
  const json = canonicalJson(seal);
  return { json, hash: createHash("sha256").update(json, "utf8").digest("hex") };
}

/** O João fecha o dia. */
export async function closeConfirmDay(o: { day: string; city: HandoverCity; cities: string[] | undefined; userId: number; userName: string | null }): Promise<{ ok: true; status: DayStatus; alert: string } | Fail> {
  const data = await loadConfirmDay(o.day, o.city, o.cities, { stripe: "db", viewerId: o.userId });
  if (!data.available) return { ok: false, code: "INTERNAL_SERVER_ERROR", message: `BD da Multipark sem resposta: ${data.reason}` };
  if (!isOpen(data.status)) return { ok: false, code: "CONFLICT", message: "O dia já está fechado." };
  if (data.blockers.length) return { ok: false, code: "BAD_REQUEST", message: data.blockers.join(" ") };
  const status = statusAfterClose({ views: data.views, summary: data.summary, reopenedBefore: data.reopenedBefore });
  const res = await inTx(async (tx) => {
    const day = await lockDay(tx, o.day, o.city);
    if (!isOpen(day?.status)) return { ok: false as const, code: "CONFLICT" as const, message: "O dia já está fechado." };
    // Alguém mexeu no dia (talão, justificação, valores…) entre a leitura e agora? Então o que se ia selar já não é o que está gravado.
    if ((await chainHeadOf(tx, o.day, o.city)) !== data.chainHead) return { ok: false as const, code: "CONFLICT" as const, message: "O dia mudou entretanto. Atualiza a página e fecha outra vez." };
    const at = utcStamp();
    const s = data.summary;
    const head = await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: "fechar", findingKey: null, data: {
      status, summary: summarySealState(s), differenceCents: s.differenceCents, absDifferenceCents: s.absDifferenceCents, alert: s.alert,
      declarations: data.shifts.map((x) => ({ shift: x.shift, cash: x.cash, mb: x.mb, multiparkTotal: x.multiparkTotal, byId: x.byId })),
      bookings: data.views.length, red: data.counts.red, amber: data.counts.amber,
    } });
    const seal = buildSeal({ day: o.day, city: o.city, summary: s, states: data.states, parkIds: data.parkIds, justificationIds: data.justifications.map((j) => j.id), fileIds: data.files.filter((f) => !f.removed).map((f) => f.id), chainHead: head, status });
    await tx.execute(sql`UPDATE cash_confirm_days SET status = ${status}, differenceCents = ${s.differenceCents}, cashDiffCents = ${s.cashDiffCents}, mbDiffCents = ${s.mbDiffCents}, alert = ${s.alert},
      closedBy = ${o.userId}, closedAt = ${at}, approvedBy = NULL, approvedAt = NULL, sealHash = ${seal.hash}, sealJson = ${seal.json}, reopenReason = NULL, lastCheckedAt = ${at} WHERE day = ${o.day} AND city = ${o.city}`);
    await appendEvent(tx, { day: o.day, city: o.city, userId: o.userId, action: "selar", findingKey: null, data: { sealHash: seal.hash } });
    return { ok: true as const };
  });
  if (!res.ok) return res;
  if (status === "a_aprovar") await notifyDay({ day: o.day, city: o.city, kind: "close", summary: data.summary, byName: o.userName, reopenedBefore: data.reopenedBefore }).catch(() => {});
  return { ok: true, status, alert: data.summary.alert };
}

/**
 * O Jorge decide: uma justificação (aprovar/recusar) ou o dia inteiro (aprovar
 * = aprova todas as justificações por decidir). Quem mexeu no dia (justificou,
 * anexou, confirmou valores, fechou) não pode decidir. Recusar reabre o dia e
 * avisa quem o fechou. Com diferença > 30 € o dia aprova-se à parte.
 */
export async function decideConfirm(o: { day: string; city: HandoverCity; justificationId: number | null; decision: "aprovado" | "recusado"; note: string | null; userId: number }): Promise<{ ok: true; status: DayStatus } | Fail> {
  const note = (o.note ?? "").trim() || null;
  if (o.decision === "recusado" && (note ?? "").length < 10) return { ok: false, code: "BAD_REQUEST", message: "Para recusar, diz porquê (pelo menos 10 carateres)." };
  const res = await inTx(async (tx) => {
    const day = await lockDay(tx, o.day, o.city);
    if (!day || isOpen(day.status)) return { ok: false as const, code: "CONFLICT" as const, message: "Só se aprova um dia depois de o João o fechar." };
    const authors = rowsOf(await tx.execute(sql`SELECT DISTINCT userId FROM cash_confirm_events WHERE day = ${o.day} AND city = ${o.city}
      AND action IN (${sql.join([...AUTHOR_ACTIONS].map((a) => sql`${a}`), sql`, `)}) AND userId IS NOT NULL`)).map((r) => Number(r.userId));
    if (authors.includes(o.userId)) return { ok: false as const, code: "FORBIDDEN" as const, message: "Mexeste neste dia (justificaste, anexaste, confirmaste ou fechaste): não o podes aprovar." };
    const pending = rowsOf(await tx.execute(sql`SELECT j.id, j.userId FROM cash_confirm_justifications j
      WHERE j.day = ${o.day} AND j.city = ${o.city}
        AND j.id = (SELECT MAX(j2.id) FROM cash_confirm_justifications j2 WHERE j2.findingKey = j.findingKey AND j2.day = j.day AND j2.city = j.city)
        AND NOT EXISTS (SELECT 1 FROM cash_confirm_decisions x WHERE x.justificationId = j.id)`));
    const at = utcStamp();
    const targets = o.justificationId == null ? pending : pending.filter((p) => Number(p.id) === o.justificationId);
    if (o.justificationId != null && !targets.length) return { ok: false as const, code: "NOT_FOUND" as const, message: "Justificação não encontrada ou já decidida." };
    for (const t of targets) {
      await tx.execute(sql`INSERT INTO cash_confirm_decisions (day, city, justificationId, decision, note, userId, at) VALUES (${o.day}, ${o.city}, ${Number(t.id)}, ${o.decision}, ${note}, ${o.userId}, ${at})`);
      const decisionId = await lastInsertId(tx);
      await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: o.decision === "aprovado" ? "aprovar_justificacao" : "recusar_justificacao", findingKey: null, data: { decisionId, justificationId: Number(t.id), note } });
    }
    let status: DayStatus = day.status as DayStatus;
    if (o.decision === "recusado") {
      status = "aberto";
      await tx.execute(sql`UPDATE cash_confirm_days SET status = 'aberto', reopenReason = ${`Recusado: ${note}`}, approvedBy = NULL, approvedAt = NULL WHERE day = ${o.day} AND city = ${o.city}`);
      await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: "reabrir", findingKey: null, data: { reason: "recusado", note } });
    } else if (o.justificationId == null || (pending.length === targets.length && (day.alert ?? "none") === "none")) {
      status = "aprovado";
      let decisionId: number | null = null;
      if (o.justificationId == null) {
        await tx.execute(sql`INSERT INTO cash_confirm_decisions (day, city, justificationId, decision, note, userId, at) VALUES (${o.day}, ${o.city}, NULL, 'aprovado', ${note}, ${o.userId}, ${at})`);
        decisionId = await lastInsertId(tx);
      }
      await tx.execute(sql`UPDATE cash_confirm_days SET status = 'aprovado', approvedBy = ${o.userId}, approvedAt = ${at} WHERE day = ${o.day} AND city = ${o.city}`);
      await appendEvent(tx, { day: o.day, city: o.city, at, userId: o.userId, action: "aprovar_dia", findingKey: null, data: { decisionId, note } });
    }
    return { ok: true as const, status, closedBy: day.closedBy == null ? null : Number(day.closedBy) };
  });
  if (!res.ok) return res;
  if (o.decision === "recusado" && res.closedBy) {
    const { notify } = await import("./notify");
    await notify({ kind: "cash_confirm_refused", targetUserId: res.closedBy, city: o.city, title: `Caixa ${CITY_LABEL[o.city]} ${o.day}: justificação recusada`, body: `O dia voltou a abrir. Motivo: ${note}`, link: dayLink(o.day, o.city), entity: { type: "cash_confirm_day", id: `${o.day}:${o.city}` } }).catch(() => {});
  }
  return { ok: true, status: res.status };
}

/** Reabrir à mão (Caixa → gerir), com motivo. O próximo fecho volta a precisar de aprovação. */
export async function reopenConfirmDay(o: { day: string; city: HandoverCity; reason: string; userId: number; userName: string | null }): Promise<{ ok: true } | Fail> {
  const reason = o.reason.trim();
  if (reason.length < 10) return { ok: false, code: "BAD_REQUEST", message: "Diz porque reabres (pelo menos 10 carateres)." };
  const res = await inTx(async (tx) => {
    const day = await lockDay(tx, o.day, o.city);
    if (isOpen(day?.status)) return { ok: false as const, code: "CONFLICT" as const, message: "O dia já está aberto." };
    await tx.execute(sql`UPDATE cash_confirm_days SET status = 'aberto', reopenReason = ${reason}, approvedBy = NULL, approvedAt = NULL WHERE day = ${o.day} AND city = ${o.city}`);
    await appendEvent(tx, { day: o.day, city: o.city, userId: o.userId, action: "reabrir", findingKey: null, data: { reason } });
    return { ok: true as const };
  });
  if (res.ok) await notifyDay({ day: o.day, city: o.city, kind: "reopened", reason: `${o.userName ?? "Alguém"} reabriu à mão: ${reason}` }).catch(() => {});
  return res;
}

/**
 * Passagem de turno: os valores da caixa mudam nesta gravação? Num dia já
 * confirmado não podem (pede ao Jorge para reabrir). `changed` serve para
 * registar quem os escreveu (a segregação usa essa pessoa, não o último a gravar).
 */
export async function handoverCashCheck(o: { day: string; city: string; shift: string; values: { cashierCashReceived?: number | null; cashierMbReceived?: number | null; cashierMultiparkTotal?: number | null } }): Promise<{ changed: boolean; locked: string | null }> {
  const d = await db();
  const [cur] = rowsOf(await d.execute(sql`SELECT cashierCashReceived, cashierMbReceived, cashierMultiparkTotal FROM shift_handovers WHERE handoverDate = ${o.day} AND shift = ${o.shift} AND city = ${o.city} LIMIT 1`));
  const same = (a: unknown, b: unknown) => (a == null ? null : toCents(Number(a))) === (b == null ? null : toCents(Number(b)));
  const changed = !same(cur?.cashierCashReceived, o.values.cashierCashReceived) || !same(cur?.cashierMbReceived, o.values.cashierMbReceived) || !same(cur?.cashierMultiparkTotal, o.values.cashierMultiparkTotal);
  if (!changed) return { changed, locked: null };
  const [st] = rowsOf(await d.execute(sql`SELECT status FROM cash_confirm_days WHERE day = ${o.day} AND city = ${o.city} LIMIT 1`));
  return { changed, locked: isOpen(st?.status) ? null : "A caixa deste dia já foi confirmada: os valores do fecho da caixa não se mudam (pede ao Jorge para reabrir o dia)." };
}

/** Regista quem escreveu os valores da caixa da passagem (depois de gravar). */
export async function markHandoverCashAuthor(o: { day: string; city: string; shift: string; userId: number }): Promise<void> {
  const d = await db();
  await d.execute(sql`UPDATE shift_handovers SET cashierDeclaredById = ${o.userId} WHERE handoverDate = ${o.day} AND shift = ${o.shift} AND city = ${o.city}`);
}

// ─── Mês (para o Jorge) ─────────────────────────────────────────────────────

export async function confirmMonth(month: string, cities: readonly HandoverCity[]) {
  if (!/^\d{4}-\d{2}$/.test(month) || !cities.length) return [];
  const [{ daysInRange }, { lastClosedCashDay }] = await Promise.all([import("../shared/lisbonDay"), import("../shared/cashDayWindow")]);
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT c.day, c.city, c.status, c.differenceCents, c.cashDiffCents, c.mbDiffCents, c.alert, ${DT("c.closedAt")} AS closedAt, uc.name AS closedByName, ${DT("c.approvedAt")} AS approvedAt, ua.name AS approvedByName, c.reopenReason,
      (SELECT COUNT(*) FROM cash_confirm_justifications j WHERE j.day = c.day AND j.city = c.city
         AND j.id = (SELECT MAX(j2.id) FROM cash_confirm_justifications j2 WHERE j2.findingKey = j.findingKey AND j2.day = j.day AND j2.city = j.city)
         AND NOT EXISTS (SELECT 1 FROM cash_confirm_decisions x WHERE x.justificationId = j.id)) AS pending
    FROM cash_confirm_days c LEFT JOIN users uc ON uc.id = c.closedBy LEFT JOIN users ua ON ua.id = c.approvedBy
    WHERE c.day LIKE ${`${month}-%`} AND c.city IN (${sql.join(cities.map((x) => sql`${x}`), sql`, `)}) ORDER BY c.day, c.city`));
  const byKey = new Map(rows.map((r) => [`${r.day}|${r.city}`, r]));
  const last = lastClosedCashDay();
  const days = daysInRange(`${month}-01`, `${month}-31`).filter((x) => x.startsWith(month) && x <= last);
  const out = [];
  for (const day of days) for (const city of cities) {
    const r = byKey.get(`${day}|${city}`);
    out.push({
      day, city, status: (r ? String(r.status) : "aberto") as DayStatus, opened: !!r,
      differenceCents: r?.differenceCents == null ? null : Number(r.differenceCents), cashDiffCents: r?.cashDiffCents == null ? null : Number(r.cashDiffCents), mbDiffCents: r?.mbDiffCents == null ? null : Number(r.mbDiffCents),
      alert: r?.alert ?? null, closedAt: ms3(r?.closedAt)?.slice(0, 19) ?? null, closedByName: r?.closedByName ?? null,
      approvedAt: ms3(r?.approvedAt)?.slice(0, 19) ?? null, approvedByName: r?.approvedByName ?? null, reopenReason: r?.reopenReason ?? null, pending: Number(r?.pending ?? 0),
    });
  }
  return out;
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
const dayLink = (day: string, city: string) => `/caixa?tab=confirmacao&dia=${day}&cidade=${city}`;

async function notifyDay(o: { day: string; city: string; kind: "close" | "reopened"; summary?: DaySummary; byName?: string | null; reason?: string; reopenedBefore?: boolean }) {
  const { notify } = await import("./notify");
  const link = dayLink(o.day, o.city);
  const entity = { type: "cash_confirm_day", id: `${o.day}:${o.city}` };
  const c = CITY_LABEL[o.city] ?? o.city;
  if (o.kind === "reopened") {
    await notify({ kind: "cash_confirm_alert", city: o.city, title: `Caixa ${c} ${o.day} reaberta`, body: o.reason ?? "A Multipark mudou um dia já fechado.", link, entity });
    return;
  }
  const s = o.summary!;
  const why = s.alert !== "none" ? `diferença de ${eur(s.absDifferenceCents)} (dinheiro ${eur(s.cashDiffCents)}, MB ${eur(s.mbDiffCents)})` : o.reopenedBefore ? "dia que já tinha sido reaberto" : "justificações por aprovar";
  const title = `Caixa ${c} ${o.day}: à espera da tua aprovação`;
  const body = `${o.byName ?? "O João"} fechou o dia com ${why}. Fica a amarelo no mês até aprovares.`;
  await notify({ kind: "cash_confirm_alert", city: o.city, title, body, link, entity });
  if (s.alert === "email") await notify({ kind: "cash_confirm_alert_email", city: o.city, title: `Caixa ${c} ${o.day}: diferença de ${eur(s.absDifferenceCents)}`, body, link, entity });
}

// ─── Varredura dos dias fechados ────────────────────────────────────────────

/**
 * Diferenças entre o selo e agora. Estados "<hash>|<cvd>|<tipo>|<balcão>":
 *  - mudou: saída com o dinheiro mudado, validação que voltou a "não", ou
 *    reserva cujo dinheiro de balcão do dia mudou;
 *  - entrou: saída nova no dia, ou reserva nova com dinheiro de balcão no dia
 *    (pré-pagos online e acertos PRO sem balcão não contam);
 *  - saiu: saída selada que já não é do dia, ou reserva com balcão que deixou de ter. PURA.
 */
export function sealDrift(sealStates: Record<string, string>, now: Record<string, string>): { changed: string[]; added: string[]; removed: string[] } {
  const changed: string[] = [], added: string[] = [], removed: string[] = [];
  const parse = (s: string) => { const [hash = "", flags = "", kind = "", counter = "0"] = s.split("|"); return { hash, flags, kind, counter: counter === "1" }; };
  for (const [id, h] of Object.entries(now)) {
    const n = parse(h);
    // Uma saída por concluir ("k") que aparece só conta se trouxer balcão no dia (confere-se no dia em que fechar).
    if (!(id in sealStates)) { if (n.kind === "c" || n.kind === "x" || n.counter) added.push(id); continue; }
    const s = parse(sealStates[id]);
    const reverted = [...s.flags].some((f, k) => f === "1" && n.flags[k] !== "1");
    // Uma reserva que passou a ser saída deste dia (saída posta para trás num dia fechado) também muda o hash: conta.
    if (n.hash !== s.hash || reverted) changed.push(id);
  }
  for (const [id, h] of Object.entries(sealStates)) {
    if (id in now) continue;
    const s = parse(h);
    // Uma saída por concluir que saiu do dia (fechou depois das 03:00) não reabre: confere-se no dia em que fechou.
    if (s.kind === "c" || s.kind === "x" || (s.kind !== "k" && s.counter)) removed.push(id);
  }
  return { changed, added, removed };
}

/** As contas do selo mudaram (declarações, despesas, taxas, dinheiro/MB do dia)? PURA. */
export function summaryDrift(sealSummary: unknown, now: DaySummary): string[] {
  const s = (sealSummary ?? {}) as Record<string, unknown>;
  const cur = summarySealState(now) as Record<string, unknown>;
  const LABEL: Record<string, string> = {
    computedCashCents: "dinheiro do dia", computedMbCents: "Multibanco do dia", shiftExpensesCents: "despesas do turno", feesCashCents: "taxas extra em dinheiro", feesMbCents: "taxas extra em MB",
    declaredCashCents: "dinheiro declarado", declaredMbCents: "MB declarado", declaredMultiparkTotalCents: "total da Multipark declarado",
    confirmedCashCents: "envelope", confirmedMbCents: "talões",
  };
  return Object.keys(LABEL).filter((k) => (s[k] ?? null) !== (cur[k] ?? null)).map((k) => `${LABEL[k]} ${eur(s[k] as number | null)} → ${eur(cur[k] as number | null)}`);
}

/**
 * Relê os dias fechados dos últimos RECHECK_DAYS dias (os há mais tempo por
 * reler primeiro), com os parques do selo e sem chamar a Stripe; se mudou alguma
 * coisa selada o dia reabre ("reaberto") e o Jorge é avisado. Retomável: para no
 * prazo e continua na próxima corrida.
 */
export async function recheckClosedConfirmDays(o: { deadlineAt: number; nowMs?: number }): Promise<{ checked: number; reopened: number; skipped: number; pending: number }> {
  const d = await db();
  const { addDays } = await import("../shared/lisbonDay");
  const { currentCashDay } = await import("../shared/cashDayWindow");
  const since = addDays(currentCashDay(o.nowMs ?? Date.now()), -RECHECK_DAYS);
  const days = rowsOf(await d.execute(sql`SELECT day, city FROM cash_confirm_days
    WHERE status IN ('fechado', 'a_aprovar', 'aprovado') AND day >= ${since} AND sealJson IS NOT NULL
    ORDER BY lastCheckedAt IS NULL DESC, lastCheckedAt ASC LIMIT 200`));
  let checked = 0, reopened = 0, skipped = 0;
  for (const row of days) {
    if (Date.now() > o.deadlineAt - 8_000) break;
    const day = String(row.day), city = String(row.city) as HandoverCity;
    let seal: any;
    const [sr] = rowsOf(await d.execute(sql`SELECT sealJson FROM cash_confirm_days WHERE day = ${day} AND city = ${city} LIMIT 1`));
    try { seal = JSON.parse(String(sr?.sealJson)); } catch { skipped++; continue; }
    const data = await loadConfirmDay(day, city, undefined, { stripe: "db", parkIds: Array.isArray(seal?.parkIds) ? seal.parkIds : undefined });
    if (!data.available || data.truncated) { skipped++; continue; } // sem dados completos não se conclui nada (tenta na próxima)
    checked++;
    const drift = sealDrift(seal?.states ?? {}, data.states);
    const sums = summaryDrift(seal?.summary, data.summary);
    const at = utcStamp();
    if (drift.changed.length || drift.added.length || drift.removed.length || sums.length) {
      const reason = [
        drift.changed.length || drift.added.length || drift.removed.length ? `${drift.changed.length} reserva(s) alteradas, ${drift.added.length} novas no dia, ${drift.removed.length} saíram do dia` : null,
        sums.length ? `contas do dia: ${sums.join("; ")}` : null,
      ].filter(Boolean).join(" · ");
      const did = await inTx(async (tx) => {
        const cur = await lockDay(tx, day, city);
        if (isOpen(cur?.status)) return false;
        await tx.execute(sql`UPDATE cash_confirm_days SET status = 'reaberto', reopenedAt = ${at}, reopenReason = ${`A Multipark (ou a passagem de turno) mudou depois do fecho: ${reason}.`}, approvedBy = NULL, approvedAt = NULL, lastCheckedAt = ${at} WHERE day = ${day} AND city = ${city}`);
        await appendEvent(tx, { day, city, at, userId: null, action: "reaberto_multipark", findingKey: null, data: { changed: drift.changed.slice(0, 50), added: drift.added.slice(0, 50), removed: drift.removed.slice(0, 50), summary: sums } });
        return true;
      });
      if (did) { reopened++; await notifyDay({ day, city, kind: "reopened", reason: `Mudou depois do fecho: ${reason}.` }).catch(() => {}); }
    } else {
      await d.execute(sql`UPDATE cash_confirm_days SET lastCheckedAt = ${at} WHERE day = ${day} AND city = ${city}`);
    }
  }
  return { checked, reopened, skipped, pending: Math.max(0, days.length - checked - skipped) };
}
