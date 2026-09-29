/**
 * Memória do webhook da Multipark (tabela `multipark_webhook_snapshots`,
 * migração 0240).
 *
 * Decisão do dono (28 set 2026): o que chega pelo webhook fica guardado e
 * NUNCA é reescrito nem apagado. Este módulo só faz INSERT (uma linha por
 * entrega; a mesma entrega repetida não duplica, pelo `deliveryId` único) e
 * SELECT. Não há UPDATE nem DELETE desta tabela em nenhum sítio do código —
 * `server/webhookMemory.test.ts` procura-os em todo o servidor.
 *
 * O webhook é só o AVISO (Jorge, 28 set 2026): quando chega, vamos logo à BD
 * da Multipark (só leitura, server/multiparkDb/cashCheck.ts →
 * readMultiparkSnapshot) buscar a reserva toda — preços, desconto, campanha,
 * parceiro, pro, estado da caixa, linhas de preço e pagamentos — e gravamos
 * tudo numa linha NOVA (`source = "multipark_db"`). O webhook seguinte faz o
 * mesmo noutra linha. Não dependemos do que o payload traz nem da API.
 *
 * Se a BD da Multipark não responder a tempo, a linha fica só com o payload
 * (`source = "payload"`, `dbReadError` com o motivo) e o trabalho
 * multipark-deliveries tenta outra vez nas 48 h seguintes, gravando uma linha
 * irmã (`deliveryId#db`, `source = "db_retry"`) — sem nunca mexer na primeira.
 * `dbReadAt` diz a que horas a Multipark foi lida.
 *
 * O payload inteiro também fica, mas SEM dados pessoais (email, telefone,
 * nomes, NIF, morada, matrícula…); o mesmo para as linhas e pagamentos.
 */
import crypto from "node:crypto";
import type { LiveFinance } from "./cashCheck/rules";

// ─── Tipos ──────────────────────────────────────────────────────────────────

export interface WebhookSnapshotRow {
  deliveryId: string;
  bookingId: string;
  eventType: string;
  /** "YYYY-MM-DD HH:MM:SS.mmm" UTC. */
  receivedAt: string;
  signatureValid: boolean;
  eventCreatedAt: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  parkId: string | null;
  status: string | null;
  checkIn: string | null;
  checkOut: string | null;
  bookingPrice: number | null;
  originalBookingPrice: number | null;
  parkingPrice: number | null;
  deliveryPrice: number | null;
  discountAmount: number | null;
  discountApplied: boolean | null;
  paidAmount: number | null;
  paymentMethod: string | null;
  paymentSource: string | null;
  paymentBy: string | null;
  campaignId: string | null;
  partnerId: string | null;
  partnerAmountDue: number | null;
  partnerAmountPaid: number | null;
  partnerContributedAmount: number | null;
  pro: boolean | null;
  proClientId: string | null;
  cashierClosed: boolean | null;
  cashValidated: boolean | null;
  driverValidated: boolean | null;
  /** "multipark_db" (lido da BD deles), "payload" (só o que o webhook trouxe) ou "db_retry". */
  source: SnapshotSource;
  /** Quando a BD da Multipark foi lida ("YYYY-MM-DD HH:MM:SS.mmm" UTC). */
  dbReadAt: string | null;
  /** Porque não foi lida (código curto), se não foi. */
  dbReadError: string | null;
  linesCount: number | null;
  linesTotal: number | null;
  linesPaid: number | null;
  paymentsCount: number | null;
  paymentsTotal: number | null;
  /** Métodos distintos dos pagamentos, separados por "|". */
  paymentMethods: string | null;
  /** Linhas de preço e pagamentos tal como estavam (JSON sem dados pessoais). */
  detailJson: string | null;
  payloadHash: string;
  payloadJson: string;
}

export type SnapshotSource = "multipark_db" | "payload" | "db_retry";

/** Retrato lido da memória (datas em ISO UTC). */
export interface MemorySnapshot {
  id: number;
  deliveryId: string;
  bookingId: string;
  eventType: string;
  receivedAt: string | null;
  sourceUpdatedAt: string | null;
  parkId: string | null;
  status: string | null;
  checkIn: string | null;
  checkOut: string | null;
  bookingPrice: number | null;
  originalBookingPrice: number | null;
  parkingPrice: number | null;
  deliveryPrice: number | null;
  discountAmount: number | null;
  discountApplied: boolean | null;
  paidAmount: number | null;
  paymentMethod: string | null;
  paymentSource: string | null;
  paymentBy: string | null;
  campaignId: string | null;
  partnerId: string | null;
  partnerAmountDue: number | null;
  partnerAmountPaid: number | null;
  partnerContributedAmount: number | null;
  pro: boolean | null;
  proClientId: string | null;
  cashierClosed: boolean | null;
  cashValidated: boolean | null;
  driverValidated: boolean | null;
  source: string;
  dbReadAt: string | null;
  linesCount: number | null;
  linesTotal: number | null;
  linesPaid: number | null;
  paymentsCount: number | null;
  paymentsTotal: number | null;
  paymentMethods: string[];
}

// ─── Ajudantes puros ────────────────────────────────────────────────────────

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === "object" && !Array.isArray(v);

function str(v: unknown, max = 128): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}
function money(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Math.round(Number(v) * 100) / 100;
  return null;
}
function flag(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return null;
}
/** Primeiro valor presente (não null/undefined) entre várias chaves. */
function pick(o: J, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** ISO/"YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DD HH:MM:SS" UTC (sem fuso = UTC). PURA. */
export function toMysqlUtc(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  const withT = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(withT) ? withT : `${withT}Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** O mesmo `deliveryId` que a fila usa (multiparkWebhook.parseMultiparkWebhook). PURA. */
export function webhookDeliveryId(body: unknown): string {
  const b = isObj(body) ? body : {};
  if (typeof b.id === "string" && b.id.trim() && b.id.length <= 128) return b.id;
  return `fallback-${crypto.createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex")}`;
}

// ─── Redação de dados pessoais ──────────────────────────────────────────────

/** Chaves que NUNCA ficam no payload guardado (comparação sem maiúsculas). */
const PERSONAL_KEY = /(e-?mail|phone|mobile|telem|contact|firstname|lastname|fullname|surname|^name$|clientname|customername|drivername|byname|agentname|username|holder|nif|^vat|taxnumber|taxname|taxaddress|address|morada|zip|postal|iban|bic|swift|card|licen[cs]eplate|^plate$|matricula|signature|password|token|secret|birth|document|passport|^ip$|ipaddress|useragent|lat$|lng$|latitude|longitude)/i;
/** Nomes de negócio que podem ficar (não são pessoas). */
const BUSINESS_KEYS = new Set(["parkname", "partnername", "campaignname", "servicename", "extraname", "categoryname"]);
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** Telefones: internacionais (+351 …) ou portugueses de 9 dígitos (9x… / 2…). */
const PHONE_RE = /^(\+\d[\d\s().-]{7,}|00\d[\d\s().-]{7,}|9[1236]\d{7}|2\d{8})$/;
export const REDACTED = "[redigido]";
export const PAYLOAD_MAX_CHARS = 32_000;

function isPersonalKey(k: string): boolean {
  const low = k.toLowerCase();
  if (BUSINESS_KEYS.has(low)) return false;
  return PERSONAL_KEY.test(low);
}

/**
 * Cópia do payload sem dados pessoais: tira as chaves pessoais (email,
 * telefone, nomes, NIF, morada, matrícula, assinaturas…) e troca qualquer
 * texto com ar de email por "[redigido]". Limita profundidade, listas e
 * tamanho dos textos. PURA.
 */
export function redactPayload(v: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactPayload(x, depth + 1));
  if (isObj(v)) {
    const out: J = {};
    for (const [k, x] of Object.entries(v)) {
      if (isPersonalKey(k)) continue;
      out[k] = redactPayload(x, depth + 1);
    }
    return out;
  }
  if (typeof v === "string") {
    if (EMAIL_RE.test(v)) return REDACTED;
    if (PHONE_RE.test(v.trim())) return REDACTED;
    return v.length > 500 ? `${v.slice(0, 497)}…` : v;
  }
  return v;
}

/** JSON redigido e limitado (se passar do limite, fica só a lista de chaves). PURA. */
export function redactedPayloadJson(body: unknown): string {
  const json = JSON.stringify(redactPayload(body) ?? null);
  if (json.length <= PAYLOAD_MAX_CHARS) return json;
  const b = isObj(body) ? body : {};
  const data = isObj(b.data) ? b.data : {};
  return JSON.stringify({ truncated: true, keys: Object.keys(b).slice(0, 50), dataKeys: Object.keys(data).filter((k) => !isPersonalKey(k)).slice(0, 200) });
}

// ─── Payload → linha ────────────────────────────────────────────────────────

/**
 * Payload autenticado → linha da memória. `null` se não houver id de reserva
 * (não há nada a lembrar). Guarda QUALQUER tipo de evento (também os que a
 * fila ignora), porque a memória é do que chegou, não do que processámos. PURA.
 */
export function buildWebhookSnapshot(body: unknown, meta: { receivedAt: Date; signatureValid: boolean; rawBody?: Buffer | string }): WebhookSnapshotRow | null {
  if (!isObj(body)) return null;
  const data = isObj(body.data) ? body.data : {};
  const bookingId = typeof data.id === "string" ? data.id.trim() : "";
  if (!bookingId || bookingId.length > 128) return null;
  const pricing = isObj(data.pricing) ? data.pricing : {};
  const cashier = isObj(data.cashier) ? data.cashier : {};
  const raw = meta.rawBody ?? JSON.stringify(body);
  return {
    deliveryId: webhookDeliveryId(body),
    bookingId,
    eventType: str(body.event, 64) ?? "UNKNOWN",
    receivedAt: meta.receivedAt.toISOString().slice(0, 23).replace("T", " "),
    signatureValid: meta.signatureValid,
    eventCreatedAt: toMysqlUtc(body.createdAt),
    sourceCreatedAt: toMysqlUtc(data.createdAt),
    sourceUpdatedAt: toMysqlUtc(data.updatedAt),
    parkId: str(data.parkId),
    status: str(data.status, 40),
    checkIn: toMysqlUtc(pick(data, "checkIn", "checkInDate")),
    checkOut: toMysqlUtc(pick(data, "checkOut", "checkOutDate")),
    bookingPrice: money(pick(data, "bookingPrice", "totalPrice") ?? pick(pricing, "totalPrice", "total")),
    originalBookingPrice: money(pick(data, "originalBookingPrice")),
    parkingPrice: money(pick(data, "parkingPrice") ?? pricing.parkingPrice),
    deliveryPrice: money(pick(data, "deliveryPrice") ?? pick(pricing, "deliveryCharges", "deliveryPrice")),
    discountAmount: money(pick(data, "discountAmount", "discount") ?? pricing.discount),
    discountApplied: flag(data.discountApplied),
    paidAmount: money(pick(data, "totalPaid", "amountPaid", "paidAmount") ?? pick(pricing, "totalPaid", "amountPaid")),
    paymentMethod: str(pick(data, "paymentMethod") ?? pricing.paymentMethod),
    paymentSource: str(data.paymentSource, 64),
    paymentBy: str(data.paymentBy, 64),
    campaignId: str(data.campaignId),
    partnerId: str(data.partnerId),
    partnerAmountDue: money(data.partnerAmountDue),
    partnerAmountPaid: money(data.partnerAmountPaid),
    partnerContributedAmount: money(data.partnerContributedAmount),
    pro: flag(data.pro),
    proClientId: str(data.proClientId),
    cashierClosed: flag(pick(data, "cashierClosed") ?? cashier.cashierClosed),
    cashValidated: flag(pick(data, "cashValidated") ?? cashier.cashValidated),
    driverValidated: flag(pick(data, "driverValidated") ?? cashier.driverValidated),
    source: "payload",
    dbReadAt: null,
    dbReadError: null,
    linesCount: null,
    linesTotal: null,
    linesPaid: null,
    paymentsCount: null,
    paymentsTotal: null,
    paymentMethods: null,
    detailJson: null,
    payloadHash: crypto.createHash("sha256").update(raw).digest("hex"),
    payloadJson: redactedPayloadJson(body),
  };
}

// ─── BD da Multipark → linha ────────────────────────────────────────────────

/** O que a leitura da BD da Multipark devolve (cashCheck.readMultiparkSnapshot). */
export interface MultiparkRead {
  live: LiveFinance | null;
  lines: unknown[];
  payments: unknown[];
}

export const DETAIL_MAX_CHARS = 60_000;

/** Linhas + pagamentos → JSON sem dados pessoais (se for grande de mais, só as contagens). PURA. */
export function detailJsonOf(lines: unknown[], payments: unknown[]): string {
  const json = JSON.stringify({ lines: redactPayload(lines), payments: redactPayload(payments) });
  if (json.length <= DETAIL_MAX_CHARS) return json;
  return JSON.stringify({ truncated: true, lines: lines.length, payments: payments.length });
}

const mysqlMs = (d: Date) => d.toISOString().slice(0, 23).replace("T", " ");

/**
 * Linha do payload + o que a BD da Multipark diz agora → linha a gravar. O que
 * a BD diz ganha; o payload só fica onde a BD não tem valor. PURA.
 */
export function mergeMultiparkRead(row: WebhookSnapshotRow, read: MultiparkRead, readAt: Date, source: "multipark_db" | "db_retry" = "multipark_db"): WebhookSnapshotRow {
  const x = read.live;
  if (!x) return { ...row, source, dbReadAt: mysqlMs(readAt), dbReadError: "NOT_FOUND" };
  const or = <T,>(a: T | null | undefined, b: T | null): T | null => (a === null || a === undefined ? b : a);
  return {
    ...row,
    sourceUpdatedAt: or(toMysqlUtc(x.updatedAt), row.sourceUpdatedAt),
    parkId: or(x.parkId, row.parkId),
    status: or(x.status, row.status),
    checkIn: or(toMysqlUtc(x.checkIn), row.checkIn),
    checkOut: or(toMysqlUtc(x.checkOut), row.checkOut),
    bookingPrice: or(x.bookingPrice, row.bookingPrice),
    originalBookingPrice: or(x.originalBookingPrice, row.originalBookingPrice),
    parkingPrice: or(x.parkingPrice, row.parkingPrice),
    deliveryPrice: or(x.deliveryPrice, row.deliveryPrice),
    discountAmount: or(x.discountAmount, row.discountAmount),
    discountApplied: or(x.discountApplied, row.discountApplied),
    paidAmount: x.paymentsCount > 0 && x.paymentsTotal != null ? x.paymentsTotal : or(x.linesPaid, row.paidAmount),
    paymentMethod: or(x.paymentMethod, row.paymentMethod),
    paymentSource: or(x.paymentSource, row.paymentSource),
    paymentBy: or(x.paymentBy, row.paymentBy),
    campaignId: or(x.campaignId, row.campaignId),
    partnerId: or(x.partnerId, row.partnerId),
    partnerAmountDue: or(x.partnerAmountDue, row.partnerAmountDue),
    partnerAmountPaid: or(x.partnerAmountPaid, row.partnerAmountPaid),
    partnerContributedAmount: or(x.partnerContributedAmount, row.partnerContributedAmount),
    pro: x.pro,
    proClientId: or(x.proClientId, row.proClientId),
    cashierClosed: x.cashierClosed.done,
    cashValidated: x.cashValidated.done,
    driverValidated: x.driverValidated.done,
    source,
    dbReadAt: mysqlMs(readAt),
    dbReadError: null,
    linesCount: x.linesCount,
    linesTotal: x.linesTotal,
    linesPaid: x.linesPaid,
    paymentsCount: x.paymentsCount,
    paymentsTotal: x.paymentsTotal,
    paymentMethods: x.paymentMethods.length ? x.paymentMethods.join("|").slice(0, 255) : null,
    detailJson: detailJsonOf(read.lines, read.payments),
  };
}

/** Tempo máximo à espera da BD da Multipark dentro do webhook (depois grava só o payload). */
export const WEBHOOK_DB_READ_TIMEOUT_MS = 6_000;
/** Erros que não vale a pena repetir (configuração, não a BD em baixo). */
export const DB_READ_NO_RETRY = ["NOT_CONFIGURED", "BAD_URL", "NOT_READ_ONLY"] as const;

function readErrorCode(err: unknown): string {
  const code = (err as any)?.code;
  return typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? code : "READ_FAILED";
}

type Reader = (bookingId: string) => Promise<MultiparkRead>;

async function defaultReader(bookingId: string): Promise<MultiparkRead> {
  const { readMultiparkSnapshot } = await import("./multiparkDb/cashCheck");
  return readMultiparkSnapshot(bookingId);
}

/** Lê a BD da Multipark com prazo. Nunca lança: devolve a leitura ou o código do erro. */
export async function readWithTimeout(bookingId: string, timeoutMs: number, reader: Reader = defaultReader): Promise<{ read: MultiparkRead } | { error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), timeoutMs); });
    return { read: await Promise.race([reader(bookingId), timeout]) };
  } catch (err) {
    return { error: readErrorCode(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Gravar (só INSERT) ─────────────────────────────────────────────────────

type Exec = { execute: (q: any) => Promise<any> };
const SNAPSHOT_COLUMNS = [
  "deliveryId", "bookingId", "eventType", "receivedAt", "signatureValid", "eventCreatedAt", "sourceCreatedAt", "sourceUpdatedAt",
  "parkId", "status", "checkIn", "checkOut", "bookingPrice", "originalBookingPrice", "parkingPrice", "deliveryPrice",
  "discountAmount", "discountApplied", "paidAmount", "paymentMethod", "paymentSource", "paymentBy", "campaignId", "partnerId",
  "partnerAmountDue", "partnerAmountPaid", "partnerContributedAmount", "pro", "proClientId", "cashierClosed", "cashValidated",
  "driverValidated", "source", "dbReadAt", "dbReadError", "linesCount", "linesTotal", "linesPaid", "paymentsCount",
  "paymentsTotal", "paymentMethods", "detailJson", "payloadHash", "payloadJson",
] as const satisfies ReadonlyArray<keyof WebhookSnapshotRow>;

function isDuplicate(err: unknown): boolean {
  const e = err as any;
  const code = e?.code ?? e?.cause?.code;
  const errno = e?.errno ?? e?.cause?.errno;
  return code === "ER_DUP_ENTRY" || errno === 1062;
}

/**
 * Acrescenta a linha. A mesma entrega repetida (mesmo `deliveryId`) é
 * recusada pela chave única e conta como `duplicate`: a primeira nunca é
 * reescrita. Qualquer outro erro sobe (o webhook responde 500 e a
 * Multipark volta a tentar).
 */
export async function insertWebhookSnapshot(db: Exec, row: WebhookSnapshotRow): Promise<"stored" | "duplicate"> {
  const { sql } = await import("drizzle-orm");
  const values = SNAPSHOT_COLUMNS.map((c) => {
    const v = row[c];
    return typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
  const cols = sql.raw(SNAPSHOT_COLUMNS.map((c) => `\`${c}\``).join(", "));
  const vals = sql.join(values.map((v) => sql`${v}`), sql`, `);
  try {
    await db.execute(sql`INSERT INTO multipark_webhook_snapshots (${cols}) VALUES (${vals})`);
    return "stored";
  } catch (err) {
    if (isDuplicate(err)) return "duplicate";
    throw err;
  }
}

/**
 * Chegou um webhook: lê a reserva toda na BD da Multipark e grava uma linha
 * nova (antes de tudo o resto no webhook). Se a BD deles não responder a
 * tempo, grava o payload e o motivo (o cron repete a leitura).
 */
export async function recordWebhookSnapshot(body: unknown, meta: { signatureValid: boolean; rawBody?: Buffer | string; receivedAt?: Date; reader?: Reader; timeoutMs?: number; db?: Exec }): Promise<"stored" | "duplicate" | "skipped"> {
  const payloadRow = buildWebhookSnapshot(body, { receivedAt: meta.receivedAt ?? new Date(), signatureValid: meta.signatureValid, rawBody: meta.rawBody });
  if (!payloadRow) return "skipped";
  const r = await readWithTimeout(payloadRow.bookingId, meta.timeoutMs ?? WEBHOOK_DB_READ_TIMEOUT_MS, meta.reader);
  const row = "read" in r ? mergeMultiparkRead(payloadRow, r.read, new Date()) : { ...payloadRow, dbReadError: r.error };
  if ("error" in r) console.warn(`[webhookMemory] BD Multipark não lida (${r.error}); fica o payload e o cron repete.`);
  return insertWebhookSnapshot(meta.db ?? (await dbOrThrow()), row);
}

async function dbOrThrow(): Promise<Exec> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw Object.assign(new Error("Base de dados indisponível"), { code: "DATABASE_UNAVAILABLE" });
  return db as unknown as Exec;
}

/** Janela em que ainda vale a pena repetir a leitura da BD da Multipark. */
export const DB_RETRY_WINDOW_HOURS = 48;
export const DB_RETRY_SUFFIX = "#db";

/**
 * Repete a leitura da BD da Multipark para as linhas que ficaram só com o
 * payload (últimas 48 h, sem linha irmã `#db`). Cada sucesso é uma linha
 * NOVA `deliveryId#db` (source "db_retry"); a linha original não é tocada.
 * Uma falha não grava nada (tenta no próximo ciclo).
 */
export async function retryWebhookMemoryReads(o: { deadlineAt: number; limit?: number; reader?: Reader; db?: Exec }): Promise<{ scanned: number; stored: number; failed: number }> {
  const { sql } = await import("drizzle-orm");
  const db = o.db ?? (await dbOrThrow());
  const noRetry = sql.join(DB_READ_NO_RETRY.map((c) => sql`${c}`), sql`, `);
  const res = await db.execute(sql`SELECT s.deliveryId, s.receivedAt, s.signatureValid, s.payloadHash, s.payloadJson
    FROM multipark_webhook_snapshots s
    WHERE s.source = 'payload' AND s.dbReadError IS NOT NULL AND s.dbReadError NOT IN (${noRetry})
      AND s.receivedAt >= (UTC_TIMESTAMP() - INTERVAL ${DB_RETRY_WINDOW_HOURS} HOUR)
      AND NOT EXISTS (SELECT 1 FROM multipark_webhook_snapshots r WHERE r.deliveryId = CONCAT(s.deliveryId, ${DB_RETRY_SUFFIX}))
    ORDER BY s.receivedAt, s.id LIMIT ${Math.max(1, Math.min(o.limit ?? 30, 200))}`);
  const rows = rowsOf(res);
  let stored = 0, failed = 0;
  for (const r of rows) {
    if (Date.now() > o.deadlineAt - WEBHOOK_DB_READ_TIMEOUT_MS) break;
    let body: unknown;
    try { body = JSON.parse(String(r.payloadJson ?? "null")); } catch { failed++; continue; }
    const receivedAt = new Date(isoOrNull(r.receivedAt) ?? Date.now());
    const base = buildWebhookSnapshot(body, { receivedAt, signatureValid: boolOrNull(r.signatureValid) === true });
    if (!base) { failed++; continue; }
    const read = await readWithTimeout(base.bookingId, WEBHOOK_DB_READ_TIMEOUT_MS, o.reader);
    if ("error" in read) { failed++; continue; }
    const row = mergeMultiparkRead({ ...base, deliveryId: `${String(r.deliveryId)}${DB_RETRY_SUFFIX}`, payloadHash: String(r.payloadHash ?? base.payloadHash), payloadJson: String(r.payloadJson) }, read.read, new Date(), "db_retry");
    if ((await insertWebhookSnapshot(db, row)) === "stored") stored++;
  }
  return { scanned: rows.length, stored, failed };
}

// ─── Ler ────────────────────────────────────────────────────────────────────

export const MEMORY_READ_MAX_ROWS = 5000;

const numOrNull = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const boolOrNull = (v: unknown) => (v == null ? null : v === true || v === 1 || v === "1");
function isoOrNull(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v).trim().replace(" ", "T");
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const s = (v: unknown) => (v == null || v === "" ? null : String(v));

/** Linha da BD → retrato (sem o payload). PURA. */
export function mapMemoryRow(r: Record<string, unknown>): MemorySnapshot {
  return {
    id: Number(r.id ?? 0),
    deliveryId: String(r.deliveryId ?? ""),
    bookingId: String(r.bookingId ?? ""),
    eventType: String(r.eventType ?? ""),
    receivedAt: isoOrNull(r.receivedAt),
    sourceUpdatedAt: isoOrNull(r.sourceUpdatedAt),
    parkId: s(r.parkId),
    status: s(r.status),
    checkIn: isoOrNull(r.checkIn),
    checkOut: isoOrNull(r.checkOut),
    bookingPrice: numOrNull(r.bookingPrice),
    originalBookingPrice: numOrNull(r.originalBookingPrice),
    parkingPrice: numOrNull(r.parkingPrice),
    deliveryPrice: numOrNull(r.deliveryPrice),
    discountAmount: numOrNull(r.discountAmount),
    discountApplied: boolOrNull(r.discountApplied),
    paidAmount: numOrNull(r.paidAmount),
    paymentMethod: s(r.paymentMethod),
    paymentSource: s(r.paymentSource),
    paymentBy: s(r.paymentBy),
    campaignId: s(r.campaignId),
    partnerId: s(r.partnerId),
    partnerAmountDue: numOrNull(r.partnerAmountDue),
    partnerAmountPaid: numOrNull(r.partnerAmountPaid),
    partnerContributedAmount: numOrNull(r.partnerContributedAmount),
    pro: boolOrNull(r.pro),
    proClientId: s(r.proClientId),
    cashierClosed: boolOrNull(r.cashierClosed),
    cashValidated: boolOrNull(r.cashValidated),
    driverValidated: boolOrNull(r.driverValidated),
    source: String(r.source ?? "payload"),
    dbReadAt: isoOrNull(r.dbReadAt),
    linesCount: numOrNull(r.linesCount),
    linesTotal: numOrNull(r.linesTotal),
    linesPaid: numOrNull(r.linesPaid),
    paymentsCount: numOrNull(r.paymentsCount),
    paymentsTotal: numOrNull(r.paymentsTotal),
    paymentMethods: String(r.paymentMethods ?? "").split("|").map((x) => x.trim()).filter(Boolean),
  };
}

const NOT_READ = new Set<string>(["payloadJson", "payloadHash", "signatureValid", "eventCreatedAt", "sourceCreatedAt", "dbReadError", "detailJson"]);
const READ_COLUMNS = ["id", ...SNAPSHOT_COLUMNS.filter((c) => !NOT_READ.has(c))];

const rowsOf = (r: any): Record<string, unknown>[] => (Array.isArray(r?.[0]) ? r[0] : Array.isArray(r) ? r : []);

/** Retratos destas reservas, por ordem de chegada (Map id → lista). */
export async function listMemoryForBookings(bookingIds: readonly string[], db?: Exec): Promise<Map<string, MemorySnapshot[]>> {
  const out = new Map<string, MemorySnapshot[]>();
  const ids = [...new Set(bookingIds.filter(Boolean))].slice(0, 1000);
  if (!ids.length) return out;
  const { sql } = await import("drizzle-orm");
  const conn = db ?? ((await (await import("./db")).getDb()) as unknown as Exec | null);
  if (!conn) throw Object.assign(new Error("Base de dados indisponível"), { code: "DATABASE_UNAVAILABLE" });
  const cols = sql.raw(READ_COLUMNS.map((c) => `\`${c}\``).join(", "));
  const res = await conn.execute(sql`SELECT ${cols} FROM multipark_webhook_snapshots
    WHERE bookingId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    ORDER BY bookingId, receivedAt, id LIMIT ${MEMORY_READ_MAX_ROWS}`);
  for (const r of rowsOf(res)) {
    const m = mapMemoryRow(r);
    const list = out.get(m.bookingId) ?? [];
    list.push(m);
    out.set(m.bookingId, list);
  }
  return out;
}

/**
 * Reservas que a MEMÓRIA dá com saída no intervalo [startUtc, endUtc) nestes
 * parques (algum retrato com essa saída). Quem chama confirma com o último
 * retrato. Limite `limit`.
 */
export async function listMemoryBookingIdsByCheckout(parkIds: readonly string[], startUtc: string, endUtc: string, limit = 500, db?: Exec): Promise<string[]> {
  if (!parkIds.length) return [];
  const { sql } = await import("drizzle-orm");
  const conn = db ?? ((await (await import("./db")).getDb()) as unknown as Exec | null);
  if (!conn) throw Object.assign(new Error("Base de dados indisponível"), { code: "DATABASE_UNAVAILABLE" });
  const res = await conn.execute(sql`SELECT DISTINCT bookingId FROM multipark_webhook_snapshots
    WHERE parkId IN (${sql.join(parkIds.map((p) => sql`${p}`), sql`, `)})
      AND checkOut >= ${startUtc} AND checkOut < ${endUtc}
    ORDER BY bookingId LIMIT ${Math.max(1, Math.min(limit, 2000))}`);
  return rowsOf(res).map((r) => String(r.bookingId ?? "")).filter(Boolean);
}

// ─── "Era" de recurso: a cópia antiga (multipark_bookings) ─────────────────

/** Evento dos retratos feitos a partir da cópia antiga (não são webhooks guardados). */
export const COPY_ERA_EVENT = "COPIA_ANTIGA";

const copyNum = (v: unknown) => { if (v == null || v === "" || v === "null") return null; const x = Number(String(v).replace(/^"|"$/g, "")); return Number.isFinite(x) ? Math.round(x * 100) / 100 : null; };
const strOrNull = (v: unknown) => { if (v == null) return null; const s = String(v).replace(/^"|"$/g, ""); return s && s !== "null" ? s : null; };
const tsIso = (v: unknown) => { const s = strOrNull(v); if (!s) return null; const t = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/**
 * Linha da cópia antiga → um retrato "era". O preço vem do JSON original da
 * reserva (`bookingPrice`) quando existe; senão do `totalPrice` da cópia.
 * A cópia só é escrita pelos webhooks (o sync periódico que a reescrevia foi
 * desligado), mas ANTES disso o sync reescrevia-a — por isso é "de recurso". PURA.
 */
export function copyRowToSnapshot(r: Record<string, unknown>): MemorySnapshot {
  const at = tsIso(r.syncedAt) ?? tsIso(r.sourceUpdatedAt);
  const raw = copyNum(r.rawBookingPrice);
  return {
    id: -1, deliveryId: `copia-${String(r.externalId ?? "")}`, bookingId: String(r.externalId ?? ""), eventType: COPY_ERA_EVENT,
    receivedAt: at, sourceUpdatedAt: tsIso(r.sourceUpdatedAt), parkId: strOrNull(r.parkId), status: strOrNull(r.status),
    checkIn: tsIso(r.checkIn), checkOut: tsIso(r.checkOut),
    bookingPrice: raw ?? copyNum(r.totalPrice), originalBookingPrice: copyNum(r.rawOriginalBookingPrice),
    parkingPrice: copyNum(r.parkingPrice), deliveryPrice: copyNum(r.deliveryCharges), discountAmount: copyNum(r.discount), discountApplied: null,
    paidAmount: copyNum(r.totalPaid), paymentMethod: strOrNull(r.paymentMethod), paymentSource: null, paymentBy: null,
    campaignId: null, partnerId: strOrNull(r.partnerId), partnerAmountDue: null, partnerAmountPaid: null, partnerContributedAmount: null,
    pro: r.pro == null ? null : Number(r.pro) === 1, proClientId: null, cashierClosed: null, cashValidated: null, driverValidated: null,
    source: "copia", dbReadAt: null, linesCount: null, linesTotal: null, linesPaid: null, paymentsCount: null, paymentsTotal: null, paymentMethods: [],
  };
}

/**
 * Para as reservas SEM memória do webhook (antes de 28/09/2026 19:23), o
 * último estado da cópia antiga. Só leitura. Usado só na comparação a pedido
 * (nunca na varredura automática, para não abrir casos com um "era" incerto).
 */
export async function listCopyEraForBookings(bookingIds: readonly string[], db?: Exec): Promise<Map<string, MemorySnapshot>> {
  const out = new Map<string, MemorySnapshot>();
  const ids = [...new Set(bookingIds.filter(Boolean))].slice(0, 1000);
  if (!ids.length) return out;
  const { sql } = await import("drizzle-orm");
  const conn = db ?? ((await (await import("./db")).getDb()) as unknown as Exec | null);
  if (!conn) throw Object.assign(new Error("Base de dados indisponível"), { code: "DATABASE_UNAVAILABLE" });
  const res = await conn.execute(sql`SELECT externalId, status, parkId, checkIn, checkOut, totalPrice, parkingPrice, deliveryCharges, discount, totalPaid, paymentMethod, pro, partnerId,
      DATE_FORMAT(syncedAt, '%Y-%m-%d %H:%i:%s') AS syncedAt, DATE_FORMAT(sourceUpdatedAt, '%Y-%m-%d %H:%i:%s') AS sourceUpdatedAt,
      CASE WHEN JSON_VALID(rawJson) THEN JSON_EXTRACT(rawJson, '$.bookingPrice') END AS rawBookingPrice,
      CASE WHEN JSON_VALID(rawJson) THEN JSON_EXTRACT(rawJson, '$.originalBookingPrice') END AS rawOriginalBookingPrice
    FROM multipark_bookings WHERE externalId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) LIMIT ${ids.length}`);
  for (const r of rowsOf(res)) { const s = copyRowToSnapshot(r); if (s.bookingId) out.set(s.bookingId, s); }
  return out;
}
