/**
 * D59 (Jorge, 3 out 2026): separador "Caixa" nos Logs.
 *
 * A caixa guarda a história nas suas próprias tabelas (não no registo de
 * atividade): passos dos casos (`cash_case_events`), versões das contagens
 * (`cash_count_log`), talões de multibanco (`cash_mb_receipts`), dias de
 * multibanco confirmados (`cash_mb_days`), extratos da Viva Wallet
 * (`cash_viva_imports`) e recebimentos do fim do mês (`cash_monthly_receipts`).
 * Aqui junta-se tudo numa linha do tempo só de leitura — uma consulta por
 * tabela (sem UNION: as colunas de texto podem ter collations diferentes) e
 * a mistura/ordem é feita em código. Nada se escreve nem se apaga.
 * Todas as datas são UTC ("YYYY-MM-DD HH:MM:SS").
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";

export type CashLogKind = "case" | "count" | "mb_receipt" | "mb_day" | "viva" | "monthly";

export const CASH_LOG_KIND_LABELS: Record<CashLogKind, string> = {
  case: "Caso da caixa",
  count: "Contagem",
  mb_receipt: "Talão multibanco",
  mb_day: "Multibanco do dia",
  viva: "Extrato Viva Wallet",
  monthly: "Recebimento fim do mês",
};

export interface CashLogRow {
  key: string;
  at: string;
  userId: number | null;
  userName: string | null;
  kind: CashLogKind;
  action: string;
  detail: string;
  parkId: string | null;
  day: string | null;
}

export interface CashLogFilters {
  /** Instantes UTC "YYYY-MM-DD HH:MM:SS" (fim exclusivo). */
  from?: string;
  to?: string;
  userId?: number;
  kind?: CashLogKind;
  search?: string;
  limit?: number;
}

const rowsOf = (res: unknown): any[] => (Array.isArray(res) && Array.isArray(res[0]) ? (res[0] as any[]) : Array.isArray(res) ? (res as any[]) : []);
const DT = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s')`);
const D = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d')`);
const eur = (v: unknown) => `${Number(v ?? 0).toFixed(2).replace(".", ",")} €`;

/** Condições de data/pessoa para a coluna de instante `at` e de autor `by`. */
function whereFor(at: string, by: string, f: CashLogFilters): SQL {
  const parts: SQL[] = [sql.raw(`${at} IS NOT NULL`)];
  if (f.from) parts.push(sql`${sql.raw(at)} >= ${f.from}`);
  if (f.to) parts.push(sql`${sql.raw(at)} < ${f.to}`);
  if (f.userId != null) parts.push(sql`${sql.raw(by)} = ${f.userId}`);
  return sql.join(parts, sql` AND `);
}

/** Texto do passo de um caso. PURA. */
export function caseEventDetail(r: { caseId: unknown; label?: unknown; code?: unknown; action?: unknown; note?: unknown }): string {
  const what = String(r.label ?? r.code ?? "").trim();
  const note = String(r.note ?? "").trim();
  return `Caso #${Number(r.caseId)}${what ? ` (${what})` : ""}: ${String(r.action ?? "").trim() || "—"}${note ? ` — ${note}` : ""}`.slice(0, 1000);
}

/** Junta, filtra pelo texto e ordena (mais recente primeiro). PURA. */
export function mergeCashLogs(groups: CashLogRow[][], search: string | undefined, limit: number): CashLogRow[] {
  const q = String(search ?? "").trim().toLowerCase();
  const all = groups.flat().filter((r) => !q || `${r.detail} ${r.userName ?? ""} ${r.parkId ?? ""} ${CASH_LOG_KIND_LABELS[r.kind]}`.toLowerCase().includes(q));
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1));
  return all.slice(0, limit);
}

export async function listCashLogs(f: CashLogFilters = {}): Promise<CashLogRow[]> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível — os registos da caixa não se leram.");
  const limit = Math.max(1, Math.min(2000, f.limit ?? 500));
  const want = (k: CashLogKind) => !f.kind || f.kind === k;
  const run = async (q: SQL) => rowsOf(await db.execute(q));
  const groups: CashLogRow[][] = [];

  if (want("case")) {
    const rows = await run(sql`SELECT e.id, ${DT("e.at")} AS at, e.userId, e.action, e.note, e.caseId, c.label, c.code, c.parkId, ${D("c.day")} AS day
      FROM cash_case_events e LEFT JOIN cash_cases c ON c.id = e.caseId
      WHERE ${whereFor("e.at", "e.userId", f)} ORDER BY e.at DESC LIMIT ${limit}`);
    groups.push(rows.map((r) => ({ key: `case:${r.id}`, at: String(r.at), userId: r.userId == null ? null : Number(r.userId), userName: null, kind: "case", action: String(r.action ?? ""), detail: caseEventDetail(r), parkId: r.parkId ?? null, day: r.day ?? null })));
  }
  if (want("count")) {
    const rows = await run(sql`SELECT l.id, ${DT("l.at")} AS at, l.userId, l.countId, c.parkId, ${D("c.day")} AS day, c.shift, c.countedAmount, c.difference
      FROM cash_count_log l LEFT JOIN cash_counts c ON c.id = l.countId
      WHERE ${whereFor("l.at", "l.userId", f)} ORDER BY l.at DESC LIMIT ${limit}`);
    groups.push(rows.map((r) => ({
      key: `count:${r.id}`, at: String(r.at), userId: r.userId == null ? null : Number(r.userId), userName: null, kind: "count", action: "gravou",
      detail: `Contagem #${Number(r.countId)}${r.parkId ? ` · ${r.parkId}` : ""}${r.day ? ` · ${r.day}` : ""}${r.shift ? ` (${r.shift})` : ""} gravada${r.countedAmount != null ? ` — contado ${eur(r.countedAmount)}, diferença ${eur(r.difference)} (valores atuais)` : ""}`,
      parkId: r.parkId ?? null, day: r.day ?? null,
    })));
  }
  if (want("mb_receipt")) {
    const added = await run(sql`SELECT id, ${DT("uploadedAt")} AS at, uploadedBy AS userId, parkId, ${D("day")} AS day, amount, bookingId, note
      FROM cash_mb_receipts WHERE ${whereFor("uploadedAt", "uploadedBy", f)} ORDER BY uploadedAt DESC LIMIT ${limit}`);
    const removed = await run(sql`SELECT id, ${DT("removedAt")} AS at, removedBy AS userId, parkId, ${D("day")} AS day, amount
      FROM cash_mb_receipts WHERE ${whereFor("removedAt", "removedBy", f)} ORDER BY removedAt DESC LIMIT ${limit}`);
    groups.push(added.map((r) => ({ key: `mbr:${r.id}`, at: String(r.at), userId: r.userId == null ? null : Number(r.userId), userName: null, kind: "mb_receipt", action: "juntou",
      detail: `Talão de ${eur(r.amount)} · ${r.parkId} · ${r.day}${r.bookingId ? ` · reserva ${r.bookingId}` : ""}${r.note ? ` — ${r.note}` : ""}`, parkId: r.parkId ?? null, day: r.day ?? null })));
    groups.push(removed.map((r) => ({ key: `mbr-x:${r.id}`, at: String(r.at), userId: r.userId == null ? null : Number(r.userId), userName: null, kind: "mb_receipt", action: "tirou",
      detail: `Talão de ${eur(r.amount)} tirado · ${r.parkId} · ${r.day} (fica guardado)`, parkId: r.parkId ?? null, day: r.day ?? null })));
  }
  if (want("mb_day")) {
    const rows = await run(sql`SELECT id, ${DT("confirmedAt")} AS at, confirmedBy AS userId, parkId, ${D("day")} AS day, payments, unmatched, extraReceipts
      FROM cash_mb_days WHERE ${whereFor("confirmedAt", "confirmedBy", f)} ORDER BY confirmedAt DESC LIMIT ${limit}`);
    groups.push(rows.map((r) => ({ key: `mbd:${r.id}`, at: String(r.at), userId: r.userId == null ? null : Number(r.userId), userName: null, kind: "mb_day", action: "confirmou",
      detail: `Multibanco de ${r.day} confirmado · ${r.parkId}: ${Number(r.payments)} pagamento(s), ${Number(r.unmatched)} sem talão, ${Number(r.extraReceipts)} talão(ões) a mais`, parkId: r.parkId ?? null, day: r.day ?? null })));
  }
  if (want("viva")) {
    const rows = await run(sql`SELECT id, ${DT("uploadedAt")} AS at, uploadedBy AS userId, fileName, ${D("periodStart")} AS periodStart, ${D("periodEnd")} AS periodEnd, txnCount, matchedCount, casesOpened
      FROM cash_viva_imports WHERE ${whereFor("uploadedAt", "uploadedBy", f)} ORDER BY uploadedAt DESC LIMIT ${limit}`);
    groups.push(rows.map((r) => ({ key: `viva:${r.id}`, at: String(r.at), userId: r.userId == null ? null : Number(r.userId), userName: null, kind: "viva", action: "importou",
      detail: `Extrato ${r.fileName ?? "Viva Wallet"}${r.periodStart ? ` (${r.periodStart} a ${r.periodEnd ?? "?"})` : ""}: ${Number(r.txnCount)} transações, ${Number(r.matchedCount)} ligadas, ${Number(r.casesOpened)} caso(s) aberto(s)`, parkId: null, day: r.periodStart ?? null })));
  }
  if (want("monthly")) {
    const added = await run(sql`SELECT id, ${DT("createdAt")} AS at, createdBy AS userId, kind, entityName, entityId, month, amount, ${D("receivedOn")} AS receivedOn, note
      FROM cash_monthly_receipts WHERE ${whereFor("createdAt", "createdBy", f)} ORDER BY createdAt DESC LIMIT ${limit}`);
    const removed = await run(sql`SELECT id, ${DT("removedAt")} AS at, removedBy AS userId, kind, entityName, entityId, month, amount
      FROM cash_monthly_receipts WHERE ${whereFor("removedAt", "removedBy", f)} ORDER BY removedAt DESC LIMIT ${limit}`);
    const who = (r: any) => `${r.entityName ?? r.entityId}${r.kind ? ` (${r.kind})` : ""}`;
    groups.push(added.map((r) => ({ key: `mon:${r.id}`, at: String(r.at), userId: r.userId == null ? null : Number(r.userId), userName: null, kind: "monthly", action: "registou",
      detail: `Recebimento de ${eur(r.amount)} · ${who(r)} · ${r.month}${r.receivedOn ? ` · recebido a ${r.receivedOn}` : ""}${r.note ? ` — ${r.note}` : ""}`, parkId: null, day: null })));
    groups.push(removed.map((r) => ({ key: `mon-x:${r.id}`, at: String(r.at), userId: r.userId == null ? null : Number(r.userId), userName: null, kind: "monthly", action: "tirou",
      detail: `Recebimento de ${eur(r.amount)} tirado · ${who(r)} · ${r.month} (fica guardado)`, parkId: null, day: null })));
  }

  const out = mergeCashLogs(groups, f.search, limit);
  const ids = Array.from(new Set(out.map((r) => r.userId).filter((x): x is number => x != null && x > 0)));
  if (ids.length) {
    const names = new Map(rowsOf(await db.execute(sql`SELECT id, name, email FROM users WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`))
      .map((u) => [Number(u.id), String(u.name ?? u.email ?? `#${u.id}`)]));
    for (const r of out) if (r.userId != null) r.userName = names.get(r.userId) ?? `#${r.userId}`;
  }
  return out;
}
