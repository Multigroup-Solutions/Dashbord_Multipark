/**
 * Tarefa 62 (P1b, Q9 — Jorge: "sim"): re-dividir UMA vez o GPS dos últimos
 * 31 dias com o limite de velocidade em vigor (120 km/h, sem tolerância),
 * para setembro e outubro contarem a 120 e não a 132 (a trava da linha GPS).
 *
 * - Só o super admin pede (Atividade diária → Histórico Diário → "Re-dividir
 *   os últimos 31 dias"); corre em SEGUNDO PLANO no agendador (trabalho
 *   `gps-resplit-backfill`, de 5 em 5 min, até ~40 s por vez) e é RETOMÁVEL:
 *   o cursor (dia + id da última linha) fica numa marca em `app_settings`
 *   (`gps.resplitBackfillV1`). Pode parar-se e voltar a pedir.
 * - Cada dia usa o `resplitDriverDay` que já existe (o mesmo do "Forçar
 *   re-divisão"): refaz a máxima, os excessos e as partes por PDA a partir do
 *   GeoJSON já guardado e grava o limiar usado. Não volta ao Zello, não muda
 *   os km e NÃO avisa ninguém. Só mexe em dados derivados do GPS
 *   (daily_driver_history/driver_day_shares), nunca em dados de negócio.
 * - A Avaliação acerta-se no recálculo da noite (os últimos 31 dias) ou com
 *   Recalcular em Avaliação → Mês.
 * - Respeita o FECHO MENSAL da Avaliação (`evaluation.closedUntil`): os dias
 *   fechados saltam-se (os números de um mês pago não mudam, nem no Desempenho
 *   nem na Atividade diária); se o fecho não se conseguir ler, esse passo não
 *   re-divide nada e volta a tentar no seguinte.
 */
import { addDays } from "../shared/lisbonDay";

export const RESPLIT_BACKFILL_STATE_KEY = "gps.resplitBackfillV1";
export const RESPLIT_BACKFILL_DAYS = 31;
/** Folga para não começar um dia novo mesmo em cima do prazo. */
const MIN_LEFT_MS = 5_000;
const MAX_ERRORS = 20;

export interface ResplitBackfillState {
  state: "running" | "done" | "stopped";
  from: string;
  to: string;
  /** próximo dia a re-dividir */
  day: string;
  /** retoma dentro do dia (id da última linha feita) */
  afterId: number | null;
  daysDone: number;
  rowsDone: number;
  /** últimos erros (no máximo 20) */
  errors: string[];
  /** dias saltados por estarem fechados (fecho mensal da Avaliação) */
  daysClosed?: number;
  requestedById: number | null;
  requestedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ResplitBackfillDeps {
  read(): Promise<ResplitBackfillState | null>;
  write(s: ResplitBackfillState): Promise<void>;
  resplit(day: string, opts: { deadlineAt: number; afterId?: number }): Promise<{ processed: number; done: boolean; nextAfterId: number | null; errors: string[] }>;
  /** O fecho mensal da Avaliação (server/evaluationClose.ts); `ok: false` = não se leu → não se re-divide. */
  closedUntil(): Promise<{ ok: true; closedUntil: string | null } | { ok: false }>;
  now(): Date;
}

/** Mensagem quando o fecho do mês não se lê (fica nos erros; o passo seguinte volta a tentar). */
export const RESPLIT_CLOSED_READ_FAILED = "não deu para ler o fecho do mês da Avaliação: nada re-dividido neste passo";

/** Dias de `a` (inclusive) até `b` (exclusive), em dias de calendário. PURA. */
const dayDiff = (a: string, b: string): number => Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000));

/** Os últimos 31 dias de calendário até ontem (hoje ainda é provisório). PURA. */
export function resplitBackfillRange(todayLisbon: string): { from: string; to: string } {
  return { from: addDays(todayLisbon, -RESPLIT_BACKFILL_DAYS), to: addDays(todayLisbon, -1) };
}

/** Pedir (o super admin). A correr → fica como está (não recomeça). PURA sobre as dependências. */
export async function startResplitBackfill(deps: ResplitBackfillDeps, o: { userId: number; todayLisbon: string }): Promise<ResplitBackfillState> {
  const cur = await deps.read();
  if (cur?.state === "running") return cur;
  const { from, to } = resplitBackfillRange(o.todayLisbon);
  const at = deps.now().toISOString();
  const s: ResplitBackfillState = { state: "running", from, to, day: from, afterId: null, daysDone: 0, rowsDone: 0, errors: [], requestedById: o.userId, requestedAt: at, updatedAt: at, finishedAt: null };
  await deps.write(s);
  return s;
}

/** Parar (fica onde estava; um novo pedido recomeça os 31 dias). */
export async function stopResplitBackfill(deps: ResplitBackfillDeps): Promise<ResplitBackfillState | null> {
  const cur = await deps.read();
  if (!cur || cur.state !== "running") return cur;
  const s: ResplitBackfillState = { ...cur, state: "stopped", updatedAt: deps.now().toISOString() };
  await deps.write(s);
  return s;
}

/**
 * Um passo do trabalho do agendador: sem pedido a correr → nada. Senão,
 * re-divide dia a dia até ao prazo, guardando o cursor depois de cada dia (ou
 * a meio do dia, se o prazo acabar). Nunca lança por um dia com erro.
 */
export async function runResplitBackfillStep(deps: ResplitBackfillDeps, o: { deadlineAt: number }): Promise<{ idle: true } | { idle: false; state: ResplitBackfillState; rowsNow: number }> {
  const cur = await deps.read();
  if (!cur || cur.state !== "running") return { idle: true };
  const s: ResplitBackfillState = { ...cur, errors: [...(cur.errors ?? [])] };
  let rowsNow = 0;
  // fecho mensal: os dias fechados não se re-dividem; sem o fecho lido, nada se escreve neste passo
  const closed = await deps.closedUntil().catch(() => ({ ok: false as const }));
  if (!closed.ok) {
    s.errors = [...s.errors, `${s.day}: ${RESPLIT_CLOSED_READ_FAILED}`].slice(-MAX_ERRORS);
    s.updatedAt = deps.now().toISOString();
    await deps.write(s);
    return { idle: false, state: s, rowsNow };
  }
  if (closed.closedUntil && s.day <= closed.closedUntil) {
    const open = addDays(closed.closedUntil, 1);
    const skip = Math.min(dayDiff(s.day, open), dayDiff(s.day, addDays(s.to, 1)));
    s.daysClosed = (s.daysClosed ?? 0) + skip;
    s.day = open > s.to ? addDays(s.to, 1) : open;
    s.afterId = null;
    s.updatedAt = deps.now().toISOString();
    if (s.day > s.to) { s.state = "done"; s.finishedAt = s.updatedAt; }
    await deps.write(s);
  }
  while (s.day <= s.to && Date.now() + MIN_LEFT_MS < o.deadlineAt) {
    let r: Awaited<ReturnType<ResplitBackfillDeps["resplit"]>>;
    try {
      r = await deps.resplit(s.day, { deadlineAt: o.deadlineAt - MIN_LEFT_MS, afterId: s.afterId ?? undefined });
    } catch (err: any) {
      // erro no dia inteiro (ex.: BD): fica para o passo seguinte, no mesmo sítio
      s.errors = [...s.errors, `${s.day}: ${String(err?.message ?? err).slice(0, 120)}`].slice(-MAX_ERRORS);
      s.updatedAt = deps.now().toISOString();
      await deps.write(s);
      return { idle: false, state: s, rowsNow };
    }
    rowsNow += r.processed;
    s.rowsDone += r.processed;
    if (r.errors.length) s.errors = [...s.errors, ...r.errors.map((e) => `${s.day}: ${e}`)].slice(-MAX_ERRORS);
    if (r.done) { s.daysDone += 1; s.day = addDays(s.day, 1); s.afterId = null; }
    else s.afterId = r.nextAfterId;
    s.updatedAt = deps.now().toISOString();
    if (s.day > s.to) { s.state = "done"; s.finishedAt = s.updatedAt; }
    await deps.write(s);
    if (!r.done) break;
  }
  return { idle: false, state: s, rowsNow };
}

// ─── Dependências reais (a marca em app_settings) ───────────────────────────

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];

export async function realResplitBackfillDeps(): Promise<ResplitBackfillDeps> {
  const [{ getDb }, { sql }, { resplitDriverDay }] = await Promise.all([import("./db"), import("drizzle-orm"), import("./jobs/dailyDriverCollection")]);
  return {
    async read() {
      const db = await getDb();
      if (!db) throw new Error("BD indisponível");
      const r = rowsOf(await db.execute(sql`SELECT \`value\` FROM app_settings WHERE settingKey = ${RESPLIT_BACKFILL_STATE_KEY} LIMIT 1`))[0];
      if (!r) return null;
      const v = typeof r.value === "string" ? JSON.parse(r.value) : r.value;
      return v && typeof v === "object" ? (v as ResplitBackfillState) : null;
    },
    async write(s) {
      const db = await getDb();
      if (!db) throw new Error("BD indisponível");
      await db.execute(sql`INSERT INTO app_settings (settingKey, \`value\`) VALUES (${RESPLIT_BACKFILL_STATE_KEY}, ${JSON.stringify(s)})
        ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`);
    },
    resplit: (day, opts) => resplitDriverDay(day, opts),
    closedUntil: async () => (await import("./evaluationClose")).readEvaluationClosedUntil(),
    now: () => new Date(),
  };
}
