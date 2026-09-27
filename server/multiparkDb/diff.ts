/**
 * Diferenças entre a nossa BD (multipark_bookings, alimentada pela API/webhook)
 * e a BD da Multipark (a referência — está sempre certa). Corre na Vercel, onde
 * está a DATABASE_URL_MULTIPARK.
 *
 *   - LÊ as duas BD por inteiro (reservas, cancelamentos e quem cancelou);
 *   - compara reserva a reserva (existe? estado, data de cancelamento, entrada,
 *     saída, preço, parque) e explica o porquê de cada diferença;
 *   - devolve o resultado (resumos + lista); NÃO grava nada em nenhuma das BD
 *     (como fica guardado na nossa é decisão do Jorge, a seguir).
 *   - Na BD deles só SELECT (guarda só de leitura do client.ts).
 *   - Sem dados pessoais do cliente (nome, email, telefone, matrícula, notas).
 *
 * `computeDiffs` é PURA (testada em diff.test.ts); o resto é I/O.
 */
import { sql } from "drizzle-orm";
import { multiparkDbQuery } from "./client";

// ─── Datas (tudo em UTC "AAAA-MM-DD HH:MM:SS"; mostrar em hora de Lisboa) ─────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LISBON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const toUtcDate = (v: string) => new Date(v.trim().replace(" ", "T").replace(/Z?$/, "Z"));

/** UTC → "AAAA-MM-DD HH:MM" em hora de Lisboa. PURA. */
export function utcToLisbon(v: unknown): string | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : toUtcDate(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const p: Record<string, string> = {};
  for (const x of LISBON.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const lisbonDay = (v: string | null | undefined) => (v ? utcToLisbon(v)?.slice(0, 10) ?? null : null);
const mysqlUtc = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

function lisbonDayStartUtc(day: string): Date {
  const guess = new Date(`${day}T00:00:00Z`);
  const local = utcToLisbon(guess)!;
  const offsetMs = new Date(local.replace(" ", "T") + ":00Z").getTime() - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}

/** Dias de Lisboa [from, to] → limites UTC [start, end). PURA. */
export function lisbonRangeUtc(from: string, to: string): { start: string; end: string } {
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new Error("Datas no formato AAAA-MM-DD.");
  if (to < from) throw new Error("'to' antes de 'from'.");
  const next = new Date(`${to}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { start: mysqlUtc(lisbonDayStartUtc(from)), end: mysqlUtc(lisbonDayStartUtc(next.toISOString().slice(0, 10))) };
}

const minutesApart = (a: string, b: string) => Math.abs(toUtcDate(a).getTime() - toUtcDate(b).getTime()) / 60_000;
const sameMinute = (a: string | null, b: string | null) => (a && b ? a.slice(0, 16) === b.slice(0, 16) : a === b);

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface OurBooking {
  id: string; bookingNumber: string | null; status: string | null;
  parkId: string | null; parkName: string | null; city: string | null;
  checkIn: string | null; checkOut: string | null; createdAt: string | null;
  cancelledAt: string | null; totalPrice: number | null; detailErrorCode: string | null;
  updatedAt: string | null; // sourceUpdatedAt (a última alteração que a API nos deu)
}
export interface TheirBooking {
  id: string; allocation: string | null; status: string | null;
  parkId: string | null; parkName: string | null;
  checkIn: string | null; checkOut: string | null; createdAt: string | null; updatedAt: string | null;
  price: number | null; cancelledAt: string | null; cancelType: string | null;
  cancelAgent: string | null; cancelMovementAt: string | null;
}

export const DIFF_KINDS = ["so_nossa", "so_deles", "estado", "cancelamento", "entrada", "saida", "preco", "parque"] as const;
export type DiffKind = (typeof DIFF_KINDS)[number];

export interface Diff {
  externalId: string; kind: DiffKind; oursValue: string | null; theirsValue: string | null; reason: string;
  bookingNumber: string | null; parkId: string | null; parkName: string | null; city: string | null;
  checkIn: string | null; checkOut: string | null; bookingCreatedAt: string | null;
  oursStatus: string | null; theirsStatus: string | null;
  oursCancelledAt: string | null; theirsCancelledAt: string | null;
  cancelAgent: string | null; cancelType: string | null; detailErrorCode: string | null;
  oursUpdatedAt: string | null; theirsUpdatedAt: string | null;
}

export interface ComputeOptions {
  now: Date;
  /** Reservas deles criadas antes disto não contam como "só deles" (o dashboard ainda não existia). */
  floor?: string | null;
  /** Alterações/criações mais recentes do que isto (min) ainda podem estar a caminho pela API. */
  recentMinutes?: number;
}

// ─── Comparação (PURA) ────────────────────────────────────────────────────────

export function computeDiffs(ours: OurBooking[], theirs: TheirBooking[], opts: ComputeOptions) {
  const recentCut = mysqlUtc(new Date(opts.now.getTime() - (opts.recentMinutes ?? 30) * 60_000));
  const isRecent = (v: string | null) => !!v && v > recentCut;
  const oursById = new Map(ours.map((o) => [o.id, o]));
  const theirsById = new Map(theirs.map((t) => [t.id, t]));
  const cityByPark = new Map<string, string>();
  for (const o of ours) if (o.parkId && o.city && !cityByPark.has(o.parkId)) cityByPark.set(o.parkId, o.city);
  const ourParks = new Set(ours.map((o) => o.parkId).filter(Boolean) as string[]);

  const diffs: Diff[] = [];
  const skipped = { antesDoInicio: 0, criadasRecentes: 0, alteradasRecentes: 0 };

  const base = (o: OurBooking | undefined, t: TheirBooking | undefined): Omit<Diff, "kind" | "oursValue" | "theirsValue" | "reason"> => ({
    externalId: (t?.id ?? o?.id)!,
    bookingNumber: o?.bookingNumber ?? t?.allocation ?? null,
    parkId: t?.parkId ?? o?.parkId ?? null,
    parkName: t?.parkName ?? o?.parkName ?? null,
    city: o?.city ?? (t?.parkId ? cityByPark.get(t.parkId) ?? null : null),
    checkIn: t?.checkIn ?? o?.checkIn ?? null,
    checkOut: t?.checkOut ?? o?.checkOut ?? null,
    bookingCreatedAt: t?.createdAt ?? o?.createdAt ?? null,
    oursStatus: o?.status ?? null, theirsStatus: t?.status ?? null,
    oursCancelledAt: o?.cancelledAt ?? null, theirsCancelledAt: t?.cancelledAt ?? t?.cancelMovementAt ?? null,
    cancelAgent: t?.cancelAgent ?? null, cancelType: t?.cancelType ?? null,
    detailErrorCode: o?.detailErrorCode ?? null,
    oursUpdatedAt: o?.updatedAt ?? null, theirsUpdatedAt: t?.updatedAt ?? null,
  });
  const push = (o: OurBooking | undefined, t: TheirBooking | undefined, kind: DiffKind, oursValue: unknown, theirsValue: unknown, reason: string) =>
    diffs.push({ ...base(o, t), kind, oursValue: oursValue == null ? null : String(oursValue).slice(0, 255), theirsValue: theirsValue == null ? null : String(theirsValue).slice(0, 255), reason: reason.slice(0, 500) });

  /** Porquê de um campo diferente: a Multipark mudou depois do nosso último sync? */
  const why = (o: OurBooking, t: TheirBooking, what: string) => {
    if (t.updatedAt && (!o.updatedAt || t.updatedAt > o.updatedAt)) {
      return `${what}: alterada na Multipark a ${utcToLisbon(t.updatedAt)}, depois da última atualização que o dashboard recebeu (${utcToLisbon(o.updatedAt) ?? "nenhuma"}) — o sync não apanhou a alteração`;
    }
    return `${what}: diferente com a mesma data de alteração dos dois lados — o dashboard recebeu um valor que não é o da BD da Multipark`;
  };

  for (const t of theirs) {
    const o = oursById.get(t.id);
    if (!o) {
      if (opts.floor && t.createdAt && t.createdAt < opts.floor) { skipped.antesDoInicio++; continue; }
      if (isRecent(t.createdAt)) { skipped.criadasRecentes++; continue; }
      let reason: string;
      if (t.status === "PENDING") reason = "Reserva pendente (por pagar) na Multipark — nunca chegou ao dashboard";
      else if (t.parkId && !ourParks.has(t.parkId)) reason = `Parque sem nenhuma reserva no dashboard (${t.parkName ?? t.parkId}) — provavelmente sem chave da API`;
      else if (t.status === "CANCELLED") reason = `Cancelada na Multipark${t.cancelledAt || t.cancelMovementAt ? ` a ${utcToLisbon(t.cancelledAt ?? t.cancelMovementAt)}` : ""} e nunca chegou ao dashboard`;
      else reason = "Nunca chegou ao dashboard (nem pela API nem pelo webhook)";
      push(undefined, t, "so_deles", null, t.status, reason);
      continue;
    }
    if (isRecent(t.updatedAt)) { skipped.alteradasRecentes++; continue; }

    if ((o.status ?? null) !== (t.status ?? null)) {
      const reason = o.status === "CANCELLED" && t.status !== "CANCELLED"
        ? `Cancelada no dashboard mas ${t.status} na Multipark — reativada do lado deles ou cancelamento que não ficou gravado lá`
        : why(o, t, "Estado");
      push(o, t, "estado", o.status, t.status, reason);
    }
    if (o.status === "CANCELLED" && t.status === "CANCELLED") {
      const theirsAt = t.cancelledAt ?? t.cancelMovementAt;
      if (!o.cancelledAt && theirsAt) push(o, t, "cancelamento", null, utcToLisbon(theirsAt), "Cancelada nos dois lados, mas o dashboard não tem a data do cancelamento");
      else if (o.cancelledAt && theirsAt && minutesApart(o.cancelledAt, theirsAt) > 2) {
        push(o, t, "cancelamento", utcToLisbon(o.cancelledAt), utcToLisbon(theirsAt), "Cancelada nos dois lados com datas de cancelamento diferentes");
      }
    }
    if (o.checkIn && t.checkIn && !sameMinute(o.checkIn, t.checkIn)) push(o, t, "entrada", utcToLisbon(o.checkIn), utcToLisbon(t.checkIn), why(o, t, "Entrada"));
    if (o.checkOut && t.checkOut && !sameMinute(o.checkOut, t.checkOut)) push(o, t, "saida", utcToLisbon(o.checkOut), utcToLisbon(t.checkOut), why(o, t, "Saída"));
    if (o.totalPrice != null && t.price != null && Math.abs(o.totalPrice - t.price) >= 0.01) push(o, t, "preco", o.totalPrice.toFixed(2), t.price.toFixed(2), why(o, t, "Preço"));
    if (o.parkId && t.parkId && o.parkId !== t.parkId) push(o, t, "parque", o.parkName ?? o.parkId, t.parkName ?? t.parkId, why(o, t, "Parque"));
  }

  for (const o of ours) {
    if (theirsById.has(o.id)) continue;
    const was = o.status === "CANCELLED"
      ? `estava cancelada no dashboard${o.cancelledAt ? ` desde ${utcToLisbon(o.cancelledAt)}` : ""}`
      : `no dashboard ainda aparece como ${o.status ?? "sem estado"}`;
    const reason = o.detailErrorCode && /404/.test(o.detailErrorCode)
      ? `Apagada da BD da Multipark (a API também responde 404) — ${was}`
      : `Não existe na BD da Multipark (apagada do lado deles) — ${was}`;
    push(o, undefined, "so_nossa", o.status, null, reason);
  }

  return { diffs, skipped };
}

// ─── Resumos (PUROS) ──────────────────────────────────────────────────────────

const bump = (m: Record<string, number>, k: string | null | undefined) => { const key = k ?? "(sem)"; m[key] = (m[key] ?? 0) + 1; };
const reasonKey = (r: string) => r.replace(/ a \d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, "").replace(/\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/g, "(…)").replace(/ desde \d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, "").replace(/\([^)]*\) — provavelmente/, "(…) — provavelmente");

export function summarize(diffs: Diff[]) {
  const porTipo: Record<string, number> = {};
  const porMotivo: Record<string, Record<string, number>> = {};
  const porParque: Record<string, Record<string, number>> = {};
  const desaparecidas = { porDiaCancelamento: {} as Record<string, number>, porDiaEntrada: {} as Record<string, number>, porEstadoNosso: {} as Record<string, number> };
  for (const d of diffs) {
    bump(porTipo, d.kind);
    bump((porMotivo[d.kind] ??= {}), reasonKey(d.reason));
    bump((porParque[d.parkName ?? d.parkId ?? "(sem parque)"] ??= {}), d.kind);
    if (d.kind === "so_nossa") {
      bump(desaparecidas.porDiaCancelamento, lisbonDay(d.oursCancelledAt));
      bump(desaparecidas.porDiaEntrada, lisbonDay(d.checkIn));
      bump(desaparecidas.porEstadoNosso, d.oursStatus);
    }
  }
  return { porTipo, porMotivo, porParque, desaparecidas };
}

/** Cancelamentos por dia (Lisboa) de cada lado, nos últimos `days` dias. PURA. */
export function cancellationsByDay(ours: OurBooking[], theirs: TheirBooking[], now: Date, days = 60) {
  const from = new Date(now.getTime() - days * 86400_000).toISOString().slice(0, 10);
  const out: Record<string, { deles: number; nossa: number }> = {};
  for (const t of theirs) {
    const d = lisbonDay(t.cancelledAt ?? t.cancelMovementAt);
    if (t.status === "CANCELLED" && d && d >= from) (out[d] ??= { deles: 0, nossa: 0 }).deles++;
  }
  for (const o of ours) {
    const d = lisbonDay(o.cancelledAt);
    if (o.status === "CANCELLED" && d && d >= from) (out[d] ??= { deles: 0, nossa: 0 }).nossa++;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Tudo o que foi cancelado num dia (Lisboa), dos dois lados, e onde está agora. PURA. */
export function focusDay(day: string, ours: OurBooking[], theirs: TheirBooking[]) {
  const { start, end } = lisbonRangeUtc(day, day);
  const inDay = (v: string | null) => !!v && v >= start && v < end;
  const oursById = new Map(ours.map((o) => [o.id, o]));
  const theirsById = new Map(theirs.map((t) => [t.id, t]));
  const ids = new Set<string>();
  for (const t of theirs) if (inDay(t.cancelledAt) || inDay(t.cancelMovementAt)) ids.add(t.id);
  for (const o of ours) if (o.status === "CANCELLED" && inDay(o.cancelledAt)) ids.add(o.id);
  const porClasse: Record<string, number> = {};
  const porDiaEntrada: Record<string, number> = {};
  const porDiaCriacao: Record<string, number> = {};
  const porParque: Record<string, number> = {};
  const porQuem: Record<string, number> = {};
  const porHora: Record<string, number> = {};
  const reservas = [...ids].map((id) => {
    const o = oursById.get(id), t = theirsById.get(id);
    const theirsAt = t?.cancelledAt ?? t?.cancelMovementAt ?? null;
    const classe = !t ? "desapareceu_da_multipark"
      : !o ? "nunca_chegou_ao_dashboard"
      : o.status === "CANCELLED" && t.status === "CANCELLED" ? (inDay(o.cancelledAt) && inDay(theirsAt) ? "cancelada_nos_dois" : "cancelada_nos_dois_outra_data")
      : o.status === "CANCELLED" ? "cancelada_so_no_dashboard"
      : "cancelada_so_na_multipark";
    bump(porClasse, classe);
    bump(porDiaEntrada, lisbonDay(t?.checkIn ?? o?.checkIn ?? null));
    bump(porDiaCriacao, lisbonDay(t?.createdAt ?? o?.createdAt ?? null));
    bump(porParque, t?.parkName ?? o?.parkName ?? null);
    bump(porQuem, t?.cancelAgent ?? null);
    bump(porHora, (utcToLisbon(theirsAt ?? o?.cancelledAt ?? null) ?? "").slice(11, 13) || null);
    return {
      id, classe, reserva: o?.bookingNumber ?? t?.allocation ?? null, parque: t?.parkName ?? o?.parkName ?? null, cidade: o?.city ?? null,
      entrada: utcToLisbon(t?.checkIn ?? o?.checkIn ?? null), saida: utcToLisbon(t?.checkOut ?? o?.checkOut ?? null),
      criada: utcToLisbon(t?.createdAt ?? o?.createdAt ?? null),
      dashboard: o ? { estado: o.status, canceladaEm: utcToLisbon(o.cancelledAt), erroDetalhe: o.detailErrorCode } : null,
      multipark: t ? { estado: t.status, canceladaEm: utcToLisbon(t.cancelledAt), movimentoCancel: utcToLisbon(t.cancelMovementAt), porQuem: t.cancelAgent, tipo: t.cancelType, ultimaAlteracao: utcToLisbon(t.updatedAt) } : null,
    };
  }).sort((a, b) => a.classe.localeCompare(b.classe) || String(a.entrada).localeCompare(String(b.entrada)));
  return { dia: day, total: reservas.length, porClasse, porHora, porQuem, porParque, porDiaEntrada, porDiaCriacao, reservas };
}

// ─── Leitura das duas BD ──────────────────────────────────────────────────────

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const numOrNull = (v: unknown) => (v == null || v === "" ? null : Number(v));

async function loadTheirs(): Promise<TheirBooking[]> {
  const ts = (c: string) => `to_char(${c}, 'YYYY-MM-DD HH24:MI:SS')`;
  const rows = await multiparkDbQuery<any>(`
    SELECT b."id" AS id, b."allocation" AS allocation, b."status"::text AS status, b."parkId" AS park_id, p."name" AS park_name,
      ${ts('b."checkIn"')} AS check_in, ${ts('b."checkOut"')} AS check_out,
      ${ts('b."createdAt"')} AS created_at, ${ts('b."updatedAt"')} AS updated_at,
      b."bookingPrice" AS price, ${ts('c."createdAt"')} AS cancelled_at, c."cancellationType" AS cancel_type
    FROM "Booking" b
    LEFT JOIN "Park" p ON p."id" = b."parkId"
    LEFT JOIN "Cancellation" c ON c."bookingId" = b."id"`);
  // Quem cancelou: o último movimento CANCEL de cada reserva (uma só passagem pela History).
  const cancels = await multiparkDbQuery<any>(`
    SELECT DISTINCT ON (h."bookingId") h."bookingId" AS booking_id, h."agentName" AS agent, ${ts('h."actionTime"')} AS at
    FROM "History" h WHERE h."changeType" = 'CANCEL'
    ORDER BY h."bookingId", h."actionTime" DESC`);
  const byBooking = new Map(cancels.map((c) => [String(c.booking_id), c]));
  return rows.map((r) => {
    const c = byBooking.get(String(r.id));
    return {
      id: String(r.id), allocation: str(r.allocation), status: str(r.status), parkId: str(r.park_id), parkName: str(r.park_name),
      checkIn: str(r.check_in), checkOut: str(r.check_out), createdAt: str(r.created_at), updatedAt: str(r.updated_at),
      price: numOrNull(r.price), cancelledAt: str(r.cancelled_at), cancelType: str(r.cancel_type),
      cancelAgent: c ? str(c.agent) : null, cancelMovementAt: c ? str(c.at) : null,
    };
  });
}

async function loadOurs(db: any): Promise<OurBooking[]> {
  const f = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s')`);
  const rows = rowsOf(await db.execute(sql`
    SELECT externalId, bookingNumber, status, parkId, parkName, city,
      ${f("checkIn")} AS checkIn, ${f("checkOut")} AS checkOut, ${f("bookingCreatedAt")} AS createdAt,
      ${f("cancelledAt")} AS cancelledAt, totalPrice, detailErrorCode, ${f("sourceUpdatedAt")} AS updatedAt
    FROM multipark_bookings`));
  return rows.map((r) => ({
    id: String(r.externalId), bookingNumber: str(r.bookingNumber), status: str(r.status),
    parkId: str(r.parkId), parkName: str(r.parkName), city: str(r.city),
    checkIn: str(r.checkIn), checkOut: str(r.checkOut), createdAt: str(r.createdAt), cancelledAt: str(r.cancelledAt),
    totalPrice: numOrNull(r.totalPrice), detailErrorCode: str(r.detailErrorCode), updatedAt: str(r.updatedAt),
  }));
}

// ─── Corrida (só leitura) ─────────────────────────────────────────────────────

export interface DiffRunOptions { focus?: string | null; listLimit?: number }

export async function runMultiparkDbDiff(opts: DiffRunOptions = {}) {
  const focus = opts.focus && DAY_RE.test(opts.focus) ? opts.focus : null;
  const now = new Date();
  const t0 = Date.now();
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) throw new Error("BD do dashboard indisponível.");

  const [theirs, ours] = await Promise.all([loadTheirs(), loadOurs(db)]);
  const tLoad = Date.now() - t0;
  const floor = ours.reduce<string | null>((m, o) => (o.createdAt && (!m || o.createdAt < m) ? o.createdAt : m), null);
  const { diffs, skipped } = computeDiffs(ours, theirs, { now, floor });

  const limit = Math.max(0, Math.min(5000, opts.listLimit ?? 3000));
  const order = new Map(DIFF_KINDS.map((k, i) => [k, i]));
  const list = [...diffs]
    .sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || String(b.checkIn).localeCompare(String(a.checkIn)))
    .slice(0, limit)
    .map((d) => ({
      ...d, checkIn: utcToLisbon(d.checkIn), checkOut: utcToLisbon(d.checkOut), bookingCreatedAt: utcToLisbon(d.bookingCreatedAt),
      oursCancelledAt: utcToLisbon(d.oursCancelledAt), theirsCancelledAt: utcToLisbon(d.theirsCancelledAt),
      oursUpdatedAt: utcToLisbon(d.oursUpdatedAt), theirsUpdatedAt: utcToLisbon(d.theirsUpdatedAt),
    }));

  return {
    ok: true, ranAt: now.toISOString(), gravado: false,
    tempos: { leituraMs: tLoad, totalMs: Date.now() - t0 },
    linhas: { nossa: ours.length, deles: theirs.length, inicioDoDashboard: utcToLisbon(floor) },
    ignoradas: skipped,
    diferencas: diffs.length,
    ...summarize(diffs),
    cancelamentosPorDia: cancellationsByDay(ours, theirs, now, 60),
    foco: focus ? focusDay(focus, ours, theirs) : null,
    lista: { total: diffs.length, mostradas: list.length, diferencas: list },
  };
}

