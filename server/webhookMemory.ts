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
 * O que o payload traz hoje (server/multiparkWebhook.ts):
 *   { id, event, createdAt, data: { id, parkId, status, licensePlate,
 *     checkIn, checkOut, bookingPrice, paymentMethod, createdAt, updatedAt } }
 * Os outros campos de dinheiro (preço original, pago, desconto, campanha,
 * parceiro, pro, caixa…) ficam preparados: se a Multipark os passar a mandar,
 * são guardados sem mudar nada aqui. O payload inteiro também fica, mas SEM
 * dados pessoais (email, telefone, nomes, NIF, morada, matrícula…).
 */
import crypto from "node:crypto";

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
  payloadHash: string;
  payloadJson: string;
}

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
    payloadHash: crypto.createHash("sha256").update(raw).digest("hex"),
    payloadJson: redactedPayloadJson(body),
  };
}

// ─── Gravar (só INSERT) ─────────────────────────────────────────────────────

type Exec = { execute: (q: any) => Promise<any> };
const SNAPSHOT_COLUMNS = [
  "deliveryId", "bookingId", "eventType", "receivedAt", "signatureValid", "eventCreatedAt", "sourceCreatedAt", "sourceUpdatedAt",
  "parkId", "status", "checkIn", "checkOut", "bookingPrice", "originalBookingPrice", "parkingPrice", "deliveryPrice",
  "discountAmount", "discountApplied", "paidAmount", "paymentMethod", "paymentSource", "paymentBy", "campaignId", "partnerId",
  "partnerAmountDue", "partnerAmountPaid", "partnerContributedAmount", "pro", "proClientId", "cashierClosed", "cashValidated",
  "driverValidated", "payloadHash", "payloadJson",
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

/** Grava o payload autenticado na memória (antes de tudo o resto no webhook). */
export async function recordWebhookSnapshot(body: unknown, meta: { signatureValid: boolean; rawBody?: Buffer | string; receivedAt?: Date }): Promise<"stored" | "duplicate" | "skipped"> {
  const row = buildWebhookSnapshot(body, { receivedAt: meta.receivedAt ?? new Date(), signatureValid: meta.signatureValid, rawBody: meta.rawBody });
  if (!row) return "skipped";
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw Object.assign(new Error("Base de dados indisponível"), { code: "DATABASE_UNAVAILABLE" });
  return insertWebhookSnapshot(db as unknown as Exec, row);
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
  };
}

const READ_COLUMNS = ["id", ...SNAPSHOT_COLUMNS.filter((c) => c !== "payloadJson" && c !== "payloadHash" && c !== "signatureValid" && c !== "eventCreatedAt" && c !== "sourceCreatedAt")];

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
