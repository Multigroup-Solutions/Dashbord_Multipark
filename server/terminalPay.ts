/**
 * Terminal pelo perfil (plano 56, entrega B2) — leituras para o DINHEIRO:
 * ordenado (server/payroll/payrollData.ts) e custo dos extras
 * (server/finance/extrasCost.ts). A regra é a pura `terminalSplitOfShift`
 * (shared/pontoTerminal.ts → shared/terminalWatch.ts `sessionHoursInShift`).
 *
 *  - só se leem as sessões com `payUplift = 1` (extras: nível +1); condutores e
 *    TL ficam no terminal sem mudar o valor;
 *  - só com o interruptor PONTO_TERMINAL ligado (quem chama verifica);
 *  - meses já fechados (fecho do ordenado aprovado ou pago) não mudam: os
 *    números ficam guardados no fecho (payroll_runs / payroll_run_lines, cópia
 *    imutável) e o RH e a repetição automática não mexem em sessões desses
 *    meses (`closedPayrollMonthKeys` / `touchesClosedMonth`).
 */
import type { TerminalPaySessionLike } from "../shared/terminalWatch";
import { lisbonDayOf } from "../shared/lisbonDay";
import { toMs } from "../shared/terminalSession";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const str = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 19).replace("T", " ") : String(v));

/**
 * Sessões de nível +1 (extras) destas fichas que começaram entre `fromUtc − 1 dia`
 * e `toUtc` (UTC "YYYY-MM-DD HH:MM:SS"), por ficha. Lança se a BD falhar (quem
 * chama decide: o ordenado avisa, nunca em silêncio).
 */
export async function loadTerminalPaySessions(employeeIds: readonly number[], fromUtc: string, toUtc: string): Promise<Map<number, TerminalPaySessionLike[]>> {
  const out = new Map<number, TerminalPaySessionLike[]>();
  const ids = Array.from(new Set(employeeIds.filter((x) => Number.isInteger(x) && x > 0)));
  if (!ids.length) return out;
  const [{ getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const since = new Date(toMs(fromUtc) - 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = rowsOf(await db.execute(sql`
      SELECT employeeId,
        DATE_FORMAT(startedAt, '%Y-%m-%d %H:%i:%s') AS startedAt,
        DATE_FORMAT(endedAt, '%Y-%m-%d %H:%i:%s') AS endedAt,
        DATE_FORMAT(countedFrom, '%Y-%m-%d %H:%i:%s') AS countedFrom,
        DATE_FORMAT(countedUntil, '%Y-%m-%d %H:%i:%s') AS countedUntil,
        countedBasis, payUplift
      FROM terminal_sessions
      WHERE payUplift = 1 AND employeeId IN (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})
        AND startedAt >= ${since} AND startedAt < ${toUtc}
      ORDER BY startedAt`));
    for (const r of rows) {
      const id = Number(r.employeeId);
      if (!out.has(id)) out.set(id, []);
      out.get(id)!.push({
        startedAt: String(str(r.startedAt)), endedAt: str(r.endedAt), countedFrom: str(r.countedFrom), countedUntil: str(r.countedUntil),
        countedBasis: r.countedBasis == null ? null : String(r.countedBasis), payUplift: Number(r.payUplift ?? 0),
      });
    }
  }
  return out;
}

/** Meses ("YYYY-MM") com fecho do ordenado aprovado ou pago. Nunca lança (erro → nenhum). */
export async function closedPayrollMonthKeys(): Promise<Set<string>> {
  try {
    const [{ getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
    const db = await getDb();
    if (!db) return new Set();
    const rows = rowsOf(await db.execute(sql`SELECT DISTINCT year, month FROM payroll_runs WHERE status IN ('approved', 'paid')`));
    return new Set(rows.map((r) => `${Number(r.year)}-${String(Number(r.month)).padStart(2, "0")}`));
  } catch {
    return new Set();
  }
}

/**
 * Uma sessão (ou um intervalo corrigido) toca um mês fechado? O mês do
 * ordenado é o do dia (Lisboa) em que o TURNO do ponto começou: conta o mês da
 * entrada do ponto da sessão (`shiftStartAt`) e o dos próprios instantes. Sem
 * a entrada conhecida, conta também 16 h antes de cada instante (o turno pode
 * ter começado no dia anterior). PURA.
 */
export function touchesClosedMonth(closed: ReadonlySet<string>, o: { shiftStartAt?: string | null; instants: Array<string | number | null | undefined> }): string | null {
  if (!closed.size) return null;
  const known = o.shiftStartAt != null && Number.isFinite(toMs(o.shiftStartAt));
  const points: number[] = [];
  if (known) points.push(toMs(o.shiftStartAt!));
  for (const v of o.instants) {
    if (v == null || v === "") continue;
    const t = typeof v === "number" ? v : toMs(v);
    if (!Number.isFinite(t)) continue;
    points.push(t);
    if (!known) points.push(t - 16 * 3_600_000);
  }
  for (const t of points) {
    const key = lisbonDayOf(t).slice(0, 7);
    if (closed.has(key)) return key;
  }
  return null;
}

/** Entrada do ponto (UTC) de um registo — o início do turno a que a sessão pertence. */
export async function clockInAtOf(timeRecordId: number): Promise<string | null> {
  try {
    const [{ getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
    const db = await getDb();
    if (!db) return null;
    const r = rowsOf(await db.execute(sql`SELECT DATE_FORMAT(recordedAt, '%Y-%m-%d %H:%i:%s') AS at FROM time_records WHERE id = ${timeRecordId} AND type = 'check_in' LIMIT 1`))[0];
    return r?.at ? String(r.at) : null;
  } catch {
    return null;
  }
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
/** "2026-10" → "outubro de 2026". PURA. */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1] ?? key} de ${y}`;
}
