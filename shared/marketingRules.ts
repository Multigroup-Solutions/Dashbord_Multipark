/**
 * Regras PURAS partilhadas do Marketing (24 set 2026) — uma regra, um sítio.
 *
 *  - Cancelada = `status = 'CANCELLED'` (exatamente), a MESMA regra das
 *    Reservas & Operações (shared/operationBookings.ts: `status === 'CANCELLED'`;
 *    estado NULL conta como ativa). Antes o Marketing usava ora `<> 'CANCELLED'`
 *    (que no SQL deixa cair os NULL) ora `NOT LIKE '%CANCEL%'`.
 *  - Dia = dia de calendário de LISBOA sobre colunas em UTC
 *    (shared/lisbonDay.ts, `>= início AND < fim`). `bookingCreatedAt` está em
 *    UTC: a API Multipark devolve datas em UTC e `parseBookingDate` grava-as
 *    como UTC (sufixo Z; decisão documentada em #32, teste "interpreta o
 *    formato da API em UTC"). O Marketing tratava-a como hora de Lisboa.
 *  - ROAS s/ IVA = (receita ÷ (1 + IVA)) ÷ gasto. O gasto em anúncios não tem
 *    IVA (faturação intracomunitária da Google/Meta); a receita das reservas
 *    tem — dividir sem tirar o IVA inflacionava o ROAS em 23 %.
 *  - Ritmo de orçamento: o dia de HOJE não conta (está a meio), nem no gasto
 *    nem no esperado.
 */

export const CANCELLED_STATUS = "CANCELLED";
export function isCancelledStatus(status: string | null | undefined): boolean {
  return status === CANCELLED_STATUS;
}

/** Receita sem IVA. `vatRate` vem de FINANCE_PARAMS.vatRate (servidor). */
export function netOfVatAmount(gross: number, vatRate: number): number {
  return gross / (1 + vatRate);
}

/** ROAS sem IVA: receita líquida ÷ gasto; sem gasto → null. */
export function roasNetOfVat(revenueGross: number, spend: number, vatRate: number): number | null {
  if (!(spend > 0)) return null;
  return netOfVatAmount(revenueGross, vatRate) / spend;
}

// ─── Recolhas (Google Ads / Meta) ────────────────────────────────────────────

/** A recolha é diária: só conta como parada ao fim de 26 h (um dia + folga). */
export const SYNC_STALE_HOURS = 26;
export function isStaleSince(lastSuccessIso: string | null, nowMs: number = Date.now()): boolean {
  if (!lastSuccessIso) return true;
  const t = new Date(lastSuccessIso.includes("T") || lastSuccessIso.endsWith("Z") ? lastSuccessIso : lastSuccessIso.replace(" ", "T") + "Z").getTime();
  if (!Number.isFinite(t)) return true;
  return nowMs - t > SYNC_STALE_HOURS * 3600_000;
}

/**
 * Estado final honesto de uma execução: todas as contas falharam → failed;
 * algumas → partial; nenhuma → done. Sem contas processadas não há sucesso.
 * `ok` é falso sempre que uma conta falhou (o cron fica vermelho).
 */
export function finalSyncStatus(accountsTotal: number, accountsFailed: number): { status: "done" | "partial" | "failed"; ok: boolean } {
  if (accountsTotal <= 0) return { status: "failed", ok: false };
  if (accountsFailed <= 0) return { status: "done", ok: true };
  if (accountsFailed >= accountsTotal) return { status: "failed", ok: false };
  return { status: "partial", ok: false };
}

// ─── Ritmo de orçamento ──────────────────────────────────────────────────────

export const BUDGET_OVER_RATIO = 1.1;
export const BUDGET_UNDER_RATIO = 0.8;
/** Dias completos mínimos antes de avaliar o ritmo (ruído do início do mês). */
export const BUDGET_MIN_FULL_DAYS = 3;

export interface BudgetPacing {
  /** dias COMPLETOS decorridos (hoje não conta) */
  elapsedDays: number;
  expected: number;
  ratio: number | null;
  projected: number | null;
  status: "over" | "under" | "ok" | "early";
}

/**
 * `spentToDate` = gasto do dia 1 até ONTEM. Esperado = orçamento × dias
 * completos ÷ dias do mês. `dayOfMonth` é o dia de hoje (1..31).
 */
export function budgetPacing(i: { amount: number; spentToDate: number; dayOfMonth: number; daysInMonth: number }): BudgetPacing {
  const elapsedDays = Math.max(0, Math.min(i.daysInMonth, i.dayOfMonth - 1));
  const expected = i.daysInMonth > 0 ? (i.amount * elapsedDays) / i.daysInMonth : 0;
  if (elapsedDays < BUDGET_MIN_FULL_DAYS || !(expected > 0)) {
    return { elapsedDays, expected, ratio: null, projected: elapsedDays > 0 ? (i.spentToDate / elapsedDays) * i.daysInMonth : null, status: "early" };
  }
  const ratio = i.spentToDate / expected;
  const projected = (i.spentToDate / elapsedDays) * i.daysInMonth;
  const status = ratio > BUDGET_OVER_RATIO ? "over" : ratio < BUDGET_UNDER_RATIO ? "under" : "ok";
  return { elapsedDays, expected, ratio, projected, status };
}

// ─── Email semanal ───────────────────────────────────────────────────────────

/** Semana ISO de um dia "YYYY-MM-DD" (calendário) → "2026-W39". */
export function isoWeekKey(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Chave de idempotência do email semanal (uma vez por semana ISO do envio). */
export function weeklyReportRunKey(lisbonDay: string): string {
  return `marketing-weekly:${isoWeekKey(lisbonDay)}`;
}

/** Segunda-feira a partir das 8h de Lisboa (o cron é horário; a chave impede repetir). */
export function weeklyReportDue(clock: { dow: number; hour: number }): boolean {
  return clock.dow === 1 && clock.hour >= 8;
}

/** Semana anterior (seg–dom) e a de antes, a partir de uma segunda-feira. */
export function weeklyRanges(monday: string): { current: { from: string; to: string }; previous: { from: string; to: string } } {
  const add = (day: string, n: number) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  return { current: { from: add(monday, -7), to: add(monday, -1) }, previous: { from: add(monday, -14), to: add(monday, -8) } };
}

// ─── Moeda dos totais ───────────────────────────────────────────────────────

/** Moeda em que o Marketing soma gastos (sem conversão cambial). */
export const REPORTING_CURRENCY = "EUR";

/**
 * Uma linha de gasto entra nos totais? Só em EUR — somar USD/GBP como se
 * fossem euros dava números errados. Moeda desconhecida (null/vazia: contas
 * antigas, legado) conta como EUR, que é a moeda de todas as contas da
 * Multipark. PURA.
 */
export function countsInEurTotals(currency: string | null | undefined): boolean {
  const c = String(currency ?? "").trim().toUpperCase();
  return !c || c === REPORTING_CURRENCY;
}

export interface CurrencyExclusion { accountId: number; accountName: string | null; provider: string; currency: string; cost: number }

/** Junta por conta o gasto excluído por moeda (para o aviso visível). PURA. */
export function summarizeCurrencyExclusions(rows: Array<{ accountId: number; accountName: string | null; provider: string; currency: string | null; cost: number }>): CurrencyExclusion[] {
  const m = new Map<number, CurrencyExclusion>();
  for (const r of rows) {
    if (countsInEurTotals(r.currency)) continue;
    const e = m.get(r.accountId) ?? { accountId: r.accountId, accountName: r.accountName, provider: r.provider, currency: String(r.currency).trim().toUpperCase(), cost: 0 };
    e.cost += r.cost;
    m.set(r.accountId, e);
  }
  return Array.from(m.values()).sort((a, b) => b.cost - a.cost);
}
