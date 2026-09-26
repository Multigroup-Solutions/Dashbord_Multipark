/**
 * Relatório de cancelamentos — compara a nossa BD (multipark_bookings) com a BD
 * da Multipark para um período de dias (hora de Lisboa). Corre na Vercel, onde
 * está a DATABASE_URL_MULTIPARK. SÓ LÊ (as duas BD) e não grava nada.
 *
 * Responde a:
 *   - que reservas foram canceladas no período, de cada lado, e a que horas;
 *   - para quando eram (dia de entrada/saída previsto);
 *   - quais estão canceladas num lado e não no outro;
 *   - quais "desapareceram": temo-las mas já não existem na BD deles (ou a API
 *     devolve 404 ao detalhe).
 * Sem dados pessoais do cliente (nome, email, telefone, matrícula, observações).
 */
import { sql } from "drizzle-orm";
import { multiparkDbQuery } from "./client";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LISBON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/** "AAAA-MM-DD HH:MM:SS" em UTC → "AAAA-MM-DD HH:MM" em hora de Lisboa. PURA. */
export function utcToLisbon(v: unknown): string | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v).trim().replace(" ", "T").replace(/Z?$/, "Z"));
  if (Number.isNaN(d.getTime())) return null;
  const p: Record<string, string> = {};
  for (const x of LISBON.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Instante UTC em que começa o dia `day` em Lisboa. PURA. */
function lisbonDayStartUtc(day: string): Date {
  const guess = new Date(`${day}T00:00:00Z`);
  // Desvio de Lisboa nesse momento (0 ou +1 h), lido do próprio Intl.
  const local = utcToLisbon(guess)!; // "AAAA-MM-DD HH:MM"
  const offsetMs = new Date(local.replace(" ", "T") + ":00Z").getTime() - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}

const mysqlUtc = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/** Período em dias de Lisboa [from, to] → limites UTC [start, end). PURA. */
export function lisbonRangeUtc(from: string, to: string): { start: string; end: string } {
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new Error("Datas no formato AAAA-MM-DD.");
  if (to < from) throw new Error("'to' antes de 'from'.");
  const next = new Date(`${to}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { start: mysqlUtc(lisbonDayStartUtc(from)), end: mysqlUtc(lisbonDayStartUtc(next.toISOString().slice(0, 10))) };
}

export type CancelClass =
  | "cancelada_nos_dois"
  | "so_nossa_desapareceu_deles"   // temos cancelada; na BD deles a reserva já não existe
  | "so_nossa_ativa_deles"         // temos cancelada; deles está noutro estado (reativada?)
  | "so_nossa_outra_data"          // cancelada nos dois, mas deles noutro dia
  | "so_deles_falta_nossa"         // deles cancelada; nós nem temos a reserva
  | "so_deles_nossa_nao_cancelada" // deles cancelada; nós temos noutro estado
  | "so_deles_nossa_outra_data";   // cancelada nos dois, mas a nossa data cai fora

export interface OursRow {
  id: string; bookingNumber: string | null; status: string | null; park: string | null; city: string | null;
  checkIn: string | null; checkOut: string | null; createdAt: string | null; cancelledAt: string | null;
  cancelledAtApprox: boolean; detailErrorCode: string | null; totalPrice: number | null;
}
export interface TheirsRow {
  id: string; allocation: string | null; status: string | null; park: string | null;
  checkIn: string | null; checkOut: string | null; createdAt: string | null; updatedAt: string | null;
  cancelledAt: string | null; cancelType: string | null; refund: boolean | null; refunded: boolean | null;
  refundedAmount: number | null; price: number | null; cancelAgent: string | null; historyCancelAt: string | null;
}

/** Classifica uma reserva a partir do que cada lado tem. PURA. */
export function classify(
  ours: OursRow | undefined, theirs: TheirsRow | undefined,
  inOurRange: boolean, inTheirRange: boolean,
): CancelClass {
  const oursCancelled = ours?.status === "CANCELLED";
  const theirsCancelled = theirs?.status === "CANCELLED";
  if (inOurRange && inTheirRange) return "cancelada_nos_dois";
  if (inOurRange) {
    if (!theirs) return "so_nossa_desapareceu_deles";
    return theirsCancelled ? "so_nossa_outra_data" : "so_nossa_ativa_deles";
  }
  if (!ours) return "so_deles_falta_nossa";
  return oursCancelled ? "so_deles_nossa_outra_data" : "so_deles_nossa_nao_cancelada";
}

const THEIRS_SELECT = `
  SELECT b."id" AS id, b."allocation" AS allocation, b."status"::text AS status, p."name" AS park,
    to_char(b."checkIn", 'YYYY-MM-DD HH24:MI:SS') AS check_in,
    to_char(b."checkOut", 'YYYY-MM-DD HH24:MI:SS') AS check_out,
    to_char(b."createdAt", 'YYYY-MM-DD HH24:MI:SS') AS created_at,
    to_char(b."updatedAt", 'YYYY-MM-DD HH24:MI:SS') AS updated_at,
    to_char(c."createdAt", 'YYYY-MM-DD HH24:MI:SS') AS cancelled_at,
    c."cancellationType" AS cancel_type, c."refund" AS refund, c."refunded" AS refunded,
    c."refundedAmount" AS refunded_amount, b."bookingPrice" AS price,
    h.agent AS cancel_agent, to_char(h.at, 'YYYY-MM-DD HH24:MI:SS') AS history_cancel_at
  FROM "Booking" b
  LEFT JOIN "Park" p ON p."id" = b."parkId"
  LEFT JOIN "Cancellation" c ON c."bookingId" = b."id"
  LEFT JOIN LATERAL (
    SELECT hh."agentName" AS agent, hh."actionTime" AS at FROM "History" hh
    WHERE hh."bookingId" = b."id" AND hh."changeType" = 'CANCEL'
    ORDER BY hh."actionTime" DESC LIMIT 1
  ) h ON true`;

function mapTheirs(r: any): TheirsRow {
  return {
    id: String(r.id), allocation: r.allocation ?? null, status: r.status ?? null, park: r.park ?? null,
    checkIn: utcToLisbon(r.check_in), checkOut: utcToLisbon(r.check_out),
    createdAt: utcToLisbon(r.created_at), updatedAt: utcToLisbon(r.updated_at),
    cancelledAt: utcToLisbon(r.cancelled_at), cancelType: r.cancel_type ?? null,
    refund: r.refund == null ? null : r.refund === true || r.refund === "t",
    refunded: r.refunded == null ? null : r.refunded === true || r.refunded === "t",
    refundedAmount: r.refunded_amount == null ? null : Number(r.refunded_amount),
    price: r.price == null ? null : Number(r.price),
    cancelAgent: r.cancel_agent ?? null, historyCancelAt: utcToLisbon(r.history_cancel_at),
  };
}

const OURS_SELECT = sql`
  SELECT externalId, bookingNumber, status, parkName, city,
    DATE_FORMAT(checkIn, '%Y-%m-%d %H:%i:%s') AS checkIn, DATE_FORMAT(checkOut, '%Y-%m-%d %H:%i:%s') AS checkOut,
    DATE_FORMAT(bookingCreatedAt, '%Y-%m-%d %H:%i:%s') AS createdAt,
    DATE_FORMAT(cancelledAt, '%Y-%m-%d %H:%i:%s') AS cancelledAt,
    DATE_FORMAT(COALESCE(sourceUpdatedAt, updatedAt), '%Y-%m-%d %H:%i:%s') AS fallbackAt,
    detailErrorCode, totalPrice
  FROM multipark_bookings`;

function mapOurs(r: any): OursRow {
  const approx = !r.cancelledAt && r.status === "CANCELLED";
  return {
    id: String(r.externalId), bookingNumber: r.bookingNumber ?? null, status: r.status ?? null,
    park: r.parkName ?? null, city: r.city ?? null,
    checkIn: utcToLisbon(r.checkIn), checkOut: utcToLisbon(r.checkOut), createdAt: utcToLisbon(r.createdAt),
    cancelledAt: utcToLisbon(r.cancelledAt ?? (approx ? r.fallbackAt : null)), cancelledAtApprox: approx,
    detailErrorCode: r.detailErrorCode ?? null, totalPrice: r.totalPrice == null ? null : Number(r.totalPrice),
  };
}

const bump = (m: Record<string, number>, k: string | null | undefined) => { const key = k ?? "(sem)"; m[key] = (m[key] ?? 0) + 1; };
const day = (s: string | null) => (s ? s.slice(0, 10) : null);

export interface CancellationsOptions { from?: string; to?: string }

export async function runMultiparkDbCancellations(opts: CancellationsOptions = {}) {
  const from = opts.from || "2026-09-10";
  const to = opts.to || from;
  const { start, end } = lisbonRangeUtc(from, to);
  if ((new Date(to).getTime() - new Date(from).getTime()) / 86400_000 > 62) throw new Error("Período máximo: 62 dias.");

  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) throw new Error("BD do dashboard indisponível.");

  // ── Deles: canceladas no período (tabela Cancellation, movimentos CANCEL, ou estado CANCELLED sem registo).
  const theirsInRange = new Map<string, TheirsRow>();
  const theirsWhy: Record<string, number> = {};
  const addTheirs = (rows: any[], why: string) => {
    for (const r of rows) { const t = mapTheirs(r); if (!theirsInRange.has(t.id)) { theirsInRange.set(t.id, t); bump(theirsWhy, why); } }
  };
  addTheirs(await multiparkDbQuery(`${THEIRS_SELECT}
    WHERE c."createdAt" >= $1::timestamp AND c."createdAt" < $2::timestamp`, [start, end]), "Cancellation");
  addTheirs(await multiparkDbQuery(`${THEIRS_SELECT}
    WHERE b."id" IN (SELECT x."bookingId" FROM "History" x WHERE x."changeType" = 'CANCEL'
      AND x."actionTime" >= $1::timestamp AND x."actionTime" < $2::timestamp)`, [start, end]), "History CANCEL");
  addTheirs(await multiparkDbQuery(`${THEIRS_SELECT}
    WHERE b."status" = 'CANCELLED' AND c."id" IS NULL
      AND b."updatedAt" >= $1::timestamp AND b."updatedAt" < $2::timestamp`, [start, end]), "estado CANCELLED sem registo");

  // ── Nossas: canceladas no período (cancelledAt; sem ele, a última atualização — marcado como aproximado).
  const oursInRange = new Map<string, OursRow>();
  for (const r of rowsOf(await db.execute(sql`${OURS_SELECT}
    WHERE (cancelledAt >= ${start} AND cancelledAt < ${end})
       OR (status = 'CANCELLED' AND cancelledAt IS NULL AND COALESCE(sourceUpdatedAt, updatedAt) >= ${start} AND COALESCE(sourceUpdatedAt, updatedAt) < ${end})`))) {
    const o = mapOurs(r); oursInRange.set(o.id, o);
  }

  // ── Completar cada lado com as reservas que só o outro tem.
  const ids = [...new Set([...oursInRange.keys(), ...theirsInRange.keys()])];
  const theirsAll = new Map(theirsInRange);
  const oursAll = new Map(oursInRange);
  const missingTheirs = ids.filter((id) => !theirsAll.has(id));
  const missingOurs = ids.filter((id) => !oursAll.has(id));
  for (let i = 0; i < missingTheirs.length; i += 500) {
    const chunk = missingTheirs.slice(i, i + 500);
    for (const r of await multiparkDbQuery(`${THEIRS_SELECT} WHERE b."id" = ANY(string_to_array($1, ','))`, [chunk.join(",")])) {
      const t = mapTheirs(r); theirsAll.set(t.id, t);
    }
  }
  for (let i = 0; i < missingOurs.length; i += 500) {
    const chunk = missingOurs.slice(i, i + 500);
    for (const r of rowsOf(await db.execute(sql`${OURS_SELECT} WHERE externalId IN (${sql.join(chunk.map((x) => sql`${x}`), sql`, `)})`))) {
      const o = mapOurs(r); oursAll.set(o.id, o);
    }
  }

  // ── Classificar e resumir.
  const byClass: Record<string, number> = {};
  const byCancelDay: Record<string, number> = {};
  const byCheckInDay: Record<string, number> = {};
  const byPark: Record<string, number> = {};
  const byCancelType: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  const byCreatedDay: Record<string, number> = {};
  const rows = ids.map((id) => {
    const o = oursAll.get(id), t = theirsAll.get(id);
    const cls = classify(o, t, oursInRange.has(id), theirsInRange.has(id));
    bump(byClass, cls);
    bump(byCancelDay, day(t?.cancelledAt ?? t?.historyCancelAt ?? o?.cancelledAt ?? null));
    bump(byCheckInDay, day(t?.checkIn ?? o?.checkIn ?? null));
    bump(byCreatedDay, day(t?.createdAt ?? o?.createdAt ?? null));
    bump(byPark, t?.park ?? o?.park ?? null);
    if (t) { bump(byCancelType, t.cancelType); bump(byAgent, t.cancelAgent); }
    return {
      id, classe: cls,
      reserva: o?.bookingNumber ?? t?.allocation ?? null, parque: t?.park ?? o?.park ?? null, cidade: o?.city ?? null,
      entrada: t?.checkIn ?? o?.checkIn ?? null, saida: t?.checkOut ?? o?.checkOut ?? null, criada: t?.createdAt ?? o?.createdAt ?? null,
      nossa: o ? { estado: o.status, canceladaEm: o.cancelledAt, aproximado: o.cancelledAtApprox, erroDetalhe: o.detailErrorCode, preco: o.totalPrice } : null,
      deles: t ? {
        estado: t.status, canceladaEm: t.cancelledAt, movimentoCancel: t.historyCancelAt, porQuem: t.cancelAgent,
        tipo: t.cancelType, reembolso: t.refund, reembolsado: t.refunded, valorReembolsado: t.refundedAmount,
        preco: t.price, ultimaAlteracao: t.updatedAt,
      } : null,
    };
  }).sort((a, b) => String(a.classe).localeCompare(String(b.classe)) || String(a.entrada).localeCompare(String(b.entrada)));

  // ── "Desapareceram": reservas nossas cujo detalhe a API devolve 404 (qualquer data) → existem na BD deles?
  const gone404 = rowsOf(await db.execute(sql`${OURS_SELECT} WHERE detailErrorCode LIKE '%404%' ORDER BY checkIn DESC LIMIT 1000`)).map(mapOurs);
  const gone404Theirs = new Map<string, TheirsRow>();
  for (let i = 0; i < gone404.length; i += 500) {
    const chunk = gone404.slice(i, i + 500).map((x) => x.id);
    if (!chunk.length) continue;
    for (const r of await multiparkDbQuery(`${THEIRS_SELECT} WHERE b."id" = ANY(string_to_array($1, ','))`, [chunk.join(",")])) {
      const t = mapTheirs(r); gone404Theirs.set(t.id, t);
    }
  }
  const api404 = gone404.map((o) => {
    const t = gone404Theirs.get(o.id);
    return {
      id: o.id, reserva: o.bookingNumber, parque: o.park, entrada: o.checkIn, criada: o.createdAt,
      nossa: { estado: o.status, canceladaEm: o.cancelledAt, aproximado: o.cancelledAtApprox, erroDetalhe: o.detailErrorCode },
      existeDeles: !!t, deles: t ? { estado: t.status, canceladaEm: t.cancelledAt, porQuem: t.cancelAgent, ultimaAlteracao: t.updatedAt } : null,
    };
  });
  const api404Summary = {
    total: api404.length,
    naoExistemDeles: api404.filter((x) => !x.existeDeles).length,
    existemDeles: api404.filter((x) => x.existeDeles).length,
    porEstadoNosso: api404.reduce((m, x) => (bump(m, x.nossa.estado), m), {} as Record<string, number>),
    porDiaCancelNosso: api404.reduce((m, x) => (bump(m, day(x.nossa.canceladaEm)), m), {} as Record<string, number>),
  };

  return {
    ok: true, ranAt: new Date().toISOString(),
    periodo: { from, to, fuso: "Europe/Lisbon", utc: { start, end } },
    totais: { deles: theirsInRange.size, nossas: oursInRange.size, uniao: ids.length, origemDeles: theirsWhy },
    resumo: { porClasse: byClass, porDiaCancelamento: byCancelDay, porDiaEntrada: byCheckInDay, porDiaCriacao: byCreatedDay, porParque: byPark, porTipo: byCancelType, porQuem: byAgent },
    reservas: rows,
    desaparecidas404: { resumo: api404Summary, reservas: api404 },
  };
}

