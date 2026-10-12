/**
 * Plano 56 (A2): leituras e escritas da sessão de PDA (colunas `pdas.session*`
 * e `web_push_subscriptions.pdaId/disabledAt`, migração 0635). Tudo por SQL;
 * os testes trocam este módulo por uma BD em memória (`pdaSessionStore()`).
 *
 * Nada se apaga: acabar a sessão = pôr o nonce a NULL (só se ainda for o mesmo);
 * os avisos do PDA ficam desligados (`disabledAt`), não apagados.
 */
import { sql } from "drizzle-orm";
import type { PdaSessionRow } from "../shared/pdaSession";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];
const affected = (r: any): number => Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
const toMs = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const s = String(v).trim();
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
};
const mysqlUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export interface PdaSessionStore {
  /** Abre (ou passa para esta conta) a sessão do PDA. false = PDA inexistente/inativo. */
  start(pdaId: number, userId: number, nonce: string, now: number): Promise<boolean>;
  read(pdaId: number): Promise<PdaSessionRow | null>;
  /** Acaba a sessão só se o nonce ainda for este (outra entrada entretanto → nada). */
  clearIf(pdaId: number, nonce: string): Promise<boolean>;
  /** Sessões abertas destas contas (para a saída do ponto e o fecho automático). */
  openSessionsOf(userIds: readonly number[]): Promise<Array<{ pdaId: number; nonce: string; userId: number }>>;
  /** Todas as sessões de PDA abertas ("Terminar as sessões de todas as contas"). */
  allOpenSessions(): Promise<Array<{ pdaId: number; nonce: string; userId: number }>>;
  /** Contas da ficha (principal + employee_accounts). */
  accountsOfEmployee(employeeId: number): Promise<number[]>;
  /** Os avisos deste PDA passam para quem entrou (e voltam a ligar) — só se a sessão ainda for esta (nonce). */
  movePush(pdaId: number, userId: number, nonce: string): Promise<void>;
  /** Os avisos deste PDA desligam-se (a sessão acabou) — só se ninguém entrou entretanto. */
  disablePush(pdaId: number, now: number): Promise<void>;
  /** Nome do PDA (para o ecrã "sessão neste PDA"). */
  pdaName(pdaId: number): Promise<string | null>;
  /** Para o aviso "o PDA mudou de aparelho": token atual, cidade e nome. */
  registration(pdaId: number): Promise<{ deviceToken: string | null; projectId: number | null; name: string } | null>;
  /** Fecha o check-in desta ficha NESTE PDA (logout num PDA). */
  releaseCheckin(pdaId: number, employeeId: number, now: number, note: string): Promise<number>;
}

async function database(): Promise<any | null> {
  const { getDb } = await import("./db");
  return getDb();
}

const idList = (ids: readonly number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

export const sqlPdaSessionStore: PdaSessionStore = {
  async start(pdaId, userId, nonce, now) {
    const d = await database();
    if (!d) return false;
    const r = await d.execute(sql`UPDATE pdas SET sessionUserId = ${userId}, sessionNonce = ${nonce}, sessionStartedAt = ${mysqlUtc(now)}
      WHERE id = ${pdaId} AND status = 'active'`);
    return affected(r) > 0;
  },
  async read(pdaId) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT sessionUserId, sessionNonce, sessionStartedAt, status FROM pdas WHERE id = ${pdaId} LIMIT 1`));
    if (!r) return null;
    // PDA retirado (inativo, perdido, em manutenção): a sessão nele deixa de valer.
    const active = String(r.status ?? "active") === "active";
    return { userId: r.sessionUserId == null ? null : Number(r.sessionUserId), nonce: active ? r.sessionNonce ?? null : null, startedAt: toMs(r.sessionStartedAt) };
  },
  async clearIf(pdaId, nonce) {
    const d = await database();
    if (!d) return false;
    const r = await d.execute(sql`UPDATE pdas SET sessionNonce = NULL WHERE id = ${pdaId} AND sessionNonce = ${nonce}`);
    return affected(r) > 0;
  },
  async openSessionsOf(userIds) {
    const list = Array.from(new Set(userIds.filter((x) => Number.isInteger(x) && x > 0)));
    const d = await database();
    if (!d || !list.length) return [];
    return rowsOf(await d.execute(sql`SELECT id, sessionNonce, sessionUserId FROM pdas
      WHERE sessionUserId IN (${idList(list)}) AND sessionNonce IS NOT NULL`))
      .map((r) => ({ pdaId: Number(r.id), nonce: String(r.sessionNonce), userId: Number(r.sessionUserId) }));
  },
  async allOpenSessions() {
    const d = await database();
    if (!d) return [];
    return rowsOf(await d.execute(sql`SELECT id, sessionNonce, sessionUserId FROM pdas WHERE sessionNonce IS NOT NULL`))
      .map((r) => ({ pdaId: Number(r.id), nonce: String(r.sessionNonce), userId: Number(r.sessionUserId) }));
  },
  async accountsOfEmployee(employeeId) {
    const d = await database();
    if (!d) return [];
    return rowsOf(await d.execute(sql`SELECT userId FROM employees WHERE id = ${employeeId} AND userId IS NOT NULL
      UNION SELECT userId FROM employee_accounts WHERE employeeId = ${employeeId}`))
      .map((r) => Number(r.userId)).filter((x) => Number.isInteger(x) && x > 0);
  },
  async movePush(pdaId, userId, nonce) {
    const d = await database();
    if (!d) return;
    // Duas entradas quase ao mesmo tempo: os avisos ficam com quem tem a sessão (o nonce em pdas).
    await d.execute(sql`UPDATE web_push_subscriptions w JOIN pdas p ON p.id = w.pdaId
      SET w.userId = ${userId}, w.disabledAt = NULL
      WHERE w.pdaId = ${pdaId} AND p.sessionNonce = ${nonce} AND p.sessionUserId = ${userId}`);
  },
  async disablePush(pdaId, now) {
    const d = await database();
    if (!d) return;
    // Se entretanto outra pessoa entrou no PDA (nonce novo), os avisos são dela: não se desligam.
    await d.execute(sql`UPDATE web_push_subscriptions w JOIN pdas p ON p.id = w.pdaId
      SET w.disabledAt = ${mysqlUtc(now)}
      WHERE w.pdaId = ${pdaId} AND w.disabledAt IS NULL AND p.sessionNonce IS NULL`);
  },
  async pdaName(pdaId) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT name FROM pdas WHERE id = ${pdaId} LIMIT 1`));
    return r ? String(r.name ?? "PDA") : null;
  },
  async registration(pdaId) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT deviceToken, projectId, name FROM pdas WHERE id = ${pdaId} LIMIT 1`));
    return r ? { deviceToken: r.deviceToken ?? null, projectId: r.projectId == null ? null : Number(r.projectId), name: String(r.name ?? "PDA") } : null;
  },
  async releaseCheckin(pdaId, employeeId, now, note) {
    const d = await database();
    if (!d) return 0;
    const r = await d.execute(sql`UPDATE pda_checkins SET checkoutAt = ${mysqlUtc(now)}, checkin_status = 'checked_out',
        notes = CONCAT(COALESCE(notes, ''), ${` · ${note}`})
      WHERE pdaId = ${pdaId} AND employeeId = ${employeeId} AND checkin_status = 'checked_in'`);
    return affected(r);
  },
};

/** A loja em uso (os testes trocam-na). */
export function pdaSessionStore(): PdaSessionStore {
  return sqlPdaSessionStore;
}
